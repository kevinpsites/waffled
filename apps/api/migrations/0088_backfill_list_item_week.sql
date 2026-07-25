-- Up Migration
-- Backfill week_start for grocery rows that predate 0087 (already-hosted machines).
-- Meal-derived ('auto') and off-plan ('recipe') rows get stamped to each household's
-- CURRENT week; manually-typed ('manual') rows stay NULL (global, shown on every week).
--
-- Without this, legacy rows have week_start = NULL and render as "global" on every week,
-- which both looks wrong (this week's items appear on all weeks) and can DUPLICATE when a
-- future week is built with a same-named ingredient. Stamping them to the current week
-- fixes both. The date math mirrors lists.service.ts `householdWeekStart` exactly (honors
-- households.week_start = sunday|monday AND households.timezone), so a stamped row lands on
-- precisely the week the board's default view shows.
update list_items li
set week_start = (
  case when h.week_start = 'monday'
    -- isodow: Mon=1..Sun=7  → back 0..6 days to the Monday
    then t.today - (extract(isodow from t.today)::int - 1)
    -- dow: Sun=0..Sat=6     → back 0..6 days to the Sunday
    else t.today - extract(dow from t.today)::int
  end
)
from lists l
join households h on h.id = l.household_id
cross join lateral (
  select ((now() at time zone coalesce(nullif(btrim(h.timezone), ''), 'UTC'))::date) as today
) t
where li.list_id = l.id
  and li.week_start is null
  and li.source in ('auto', 'recipe')
  and li.deleted_at is null;

-- Down Migration
-- No-op: a stamped week_start can't be safely reverted to NULL (we no longer know which
-- rows were originally weekless). Dropping the column is handled by 0087's down migration.
