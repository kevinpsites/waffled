-- Up Migration
-- Rescue grocery rows stranded on a week key nothing can reach.
--
-- Before the routes learned to snap, "Plan the month" rebuilt with the 1st of the month —
-- 2026-09-01, a Tuesday — and stamped `list_items.week_start` with it. Every route now
-- snaps `?weekStart=` to the household's own boundary, so both the board query and the
-- rebuild's delete only ever use ALIGNED keys. Those rows are therefore invisible on every
-- board AND unreachable by every rebuild: they can never be seen, ticked, or cleaned up.
--
-- "Aligned" is tested directly rather than by re-snapping and comparing, because that IS
-- the invariant: a sunday household's weeks start on dow 0, a monday household's on
-- isodow 1. Same shape as 0088, so the two read together.
--
-- The two sources need OPPOSITE treatment, which is the whole design:
--
--   source='auto'    derived from the meal plan. `rebuildGroceryFromWeek` hard-deletes and
--                    regenerates these on every run, so an orphan is pure residue —
--                    dropping it loses nothing a rebuild won't reproduce, and MOVING it
--                    would duplicate whatever the real week's rebuild already built. It
--                    cannot even carry a meaningful `checked`: no board could render it.
--   source='recipe'  an explicit off-plan "add this recipe's shopping". Deliberately
--                    survives every rebuild, so it is NOT reproducible and must be moved.
--
-- source='manual' rows carry week_start = NULL (the global running list), so they cannot be
-- orphaned and are never touched. The `week_start is not null` guards below are what keep
-- them out — without one, every global row looks "unaligned".
--
-- Soft delete, not DELETE: every query in this app filters `deleted_at is null`, and since
-- the down migration cannot restore the original keys, a tombstone is the only recovery
-- path this change will ever have. (`list_items` is not in the PowerSync sync rules, so no
-- client holds these rows — this is purely the table's own convention.)

-- 1. The meal-derived residue.
with mapped as (
  select li.id, li.source, li.week_start,
         case when h.week_start = 'monday'
              then li.week_start - (extract(isodow from li.week_start)::int - 1)
              else li.week_start - extract(dow from li.week_start)::int
         end as target_week
    from list_items li
    join households h on h.id = li.household_id
   where li.deleted_at is null
     and li.week_start is not null
)
update list_items li
   set deleted_at = now(), updated_at = now()
  from mapped m
 where m.id = li.id
   and m.source = 'auto'
   and m.target_week <> m.week_start;

-- 2. The explicit off-plan adds: move each onto its real week, and where that would land
--    on a name the week already carries, merge instead of duplicating.
--
--    The name key is `lower(btrim(name))` because that is how the app itself dedupes
--    everywhere (offPlanByName, prevChecked, prevStore). Keyed on `name` alone, "LIMES"
--    would snap onto a week already holding "limes" and create exactly the duplicate this
--    migration exists to prevent.
--
--    Only groups that actually contain an orphan are touched, so two rows that legitimately
--    coexist on an aligned week are left exactly as they are.
with mapped as (
  select li.id, li.list_id, li.name, li.week_start, li.source_recipe_ids, li.created_at,
         lower(btrim(li.name)) as name_key,
         -- An already-aligned row snaps to itself, so this doubles as "where each live
         -- off-plan row belongs" — which is what lets an orphan find the existing row it
         -- should merge into.
         case when h.week_start = 'monday'
              then li.week_start - (extract(isodow from li.week_start)::int - 1)
              else li.week_start - extract(dow from li.week_start)::int
         end as target_week
    from list_items li
    join households h on h.id = li.household_id
   where li.deleted_at is null
     and li.week_start is not null
     and li.source = 'recipe'
),
affected as (
  select list_id, name_key, target_week
    from mapped
   group by list_id, name_key, target_week
  having bool_or(target_week <> week_start)
),
ranked as (
  select m.*,
         -- Survivor choice, in order:
         --   1. an ALREADY-ALIGNED row wins over an orphan. It is the row currently on the
         --      user's board — carrying their quantity, store and ticks — while the orphan
         --      is one they have never been able to see. Merge into what they can see.
         --   2. then oldest, 3. then id.
         -- Fully deterministic, so this is reproducible across replicas and re-runs; an
         -- arbitrary pick would not be.
         row_number() over (partition by m.list_id, m.name_key, m.target_week
                            order by (m.target_week <> m.week_start), m.created_at, m.id) as rn
    from mapped m
    join affected a
      on a.list_id = m.list_id and a.name_key = m.name_key and a.target_week = m.target_week
),
merged_ids as (
  select r.list_id, r.name_key, r.target_week, array_agg(distinct e) as all_ids
    from ranked r, lateral unnest(coalesce(r.source_recipe_ids, '{}'::uuid[])) as e
   group by r.list_id, r.name_key, r.target_week
),
survivors as (
  update list_items li
     set week_start = r.target_week,
         -- Union every merged row's recipes so no add is silently dropped. `quantity` is
         -- deliberately NOT summed: merging amounts needs mergeQuantity's unit logic, which
         -- has no SQL equivalent, and a quantity inflated by a migration is a number the
         -- user can neither explain nor undo. A slightly low number they CAN see is better.
         source_recipe_ids = coalesce(mi.all_ids, li.source_recipe_ids),
         updated_at = now()
    from ranked r
    left join merged_ids mi
      on mi.list_id = r.list_id and mi.name_key = r.name_key and mi.target_week = r.target_week
   where li.id = r.id and r.rn = 1
  returning li.id
)
update list_items li
   set deleted_at = now(), updated_at = now()
  from ranked r
 where li.id = r.id and r.rn > 1;

-- Re-running is a no-op: once every row is aligned, `affected` is empty and neither
-- statement matches anything. That matters because this repo tolerates out-of-order
-- migration application, so a database can meet this file in more than one state.

-- Down Migration
-- No-op, deliberately. The original keys were the bug — unreachable dates no board ever
-- asks for — and they are not recorded anywhere once snapped, so there is nothing to
-- restore them from. Rows merged away keep their `deleted_at` tombstone if anyone ever
-- needs to look. Same one-way reasoning as 0088's down migration.
select 1;
