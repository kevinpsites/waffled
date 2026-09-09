-- Up Migration
-- Make a cross-household `persons` reference structurally impossible.
--
-- Every row in Waffled belongs to a household, and 50 foreign keys across
-- 37 tables point at `persons(id)` with a single column. A single-column FK
-- proves only that the person EXISTS — not that they belong to the same household as
-- the referencing row. Isolation was therefore defended entirely in the application
-- layer, and the 2026-09-08 tenant-isolation audit found five write paths that had
-- forgotten the assertion (see docs/product/tenant-isolation-audit.md, finding 8).
--
-- This migration converts every one of those FKs to `(household_id, person_col)` →
-- `persons (household_id, id)`, so Postgres itself refuses the write. Delete semantics
-- are preserved exactly per constraint; see the notes on the SET NULL ones below.
--
-- Deliberately NOT converted (no household column to compose with):
--   refresh_tokens.person_id, auth_handoffs.person_id — auth-internal; the value is the
--     authenticated person, never client-supplied.
--   meal_recipes.cook_person_id — join table keyed (meal_id, recipe_id); its household is
--     derived through `meals`. Reshaping it is out of scope, so it stays on the
--     application-layer guard in the meal-builder write path.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The prerequisite: a composite FK needs a matching unique key on the parent.
--    `id` is already the primary key, so (household_id, id) is trivially unique —
--    this exists purely to be a referenceable target.
-- ─────────────────────────────────────────────────────────────────────────────

alter table persons
  add constraint persons_household_id_id_key unique (household_id, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Repair before constraining.
--
--    A deployment that ran the buggy write paths may already hold rows that violate
--    the constraint we are about to add. `ALTER TABLE ... ADD CONSTRAINT` validates
--    existing rows, so without this step the upgrade would abort on a live family's
--    database. Every statement below is a no-op on a clean install.
--
--    2a. Nullable person columns (41 of 50): the column is an *attribution* —
--        who claimed it, who checked it, whose calendar it is. A foreign person id
--        there is a bogus attribution, not a bogus row, so null the attribution and
--        keep the household's own data. This is the non-destructive repair and it
--        covers the overwhelming majority of cases.
-- ─────────────────────────────────────────────────────────────────────────────

update calendar_accounts t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update calendar_oauth_states t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update calendars t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update chore_instances t set approved_by = null
 where t.approved_by is not null
   and not exists (select 1 from persons p where p.id = t.approved_by and p.household_id = t.household_id);
update chore_instances t set claimed_by = null
 where t.claimed_by is not null
   and not exists (select 1 from persons p where p.id = t.claimed_by and p.household_id = t.household_id);
update chore_instances t set completed_by = null
 where t.completed_by is not null
   and not exists (select 1 from persons p where p.id = t.completed_by and p.household_id = t.household_id);
update chore_instances t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update chores t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update countdowns t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update event_goal_logs t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update event_participants t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update event_suggestion_dismissals t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update events t set owner_person_id = null
 where t.owner_person_id is not null
   and not exists (select 1 from persons p where p.id = t.owner_person_id and p.household_id = t.household_id);
update events t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update family_night_assignments t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update goal_logs t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update goal_logs t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update goal_steps t set done_by = null
 where t.done_by is not null
   and not exists (select 1 from persons p where p.id = t.done_by and p.household_id = t.household_id);
update health_goal_logs t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update household_invites t set invited_by = null
 where t.invited_by is not null
   and not exists (select 1 from persons p where p.id = t.invited_by and p.household_id = t.household_id);
update households t set owner_person_id = null
 where t.owner_person_id is not null
   and not exists (select 1 from persons p where p.id = t.owner_person_id and p.household_id = t.id);
update ics_feeds t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update kiosk_devices t set created_by_person_id = null
 where t.created_by_person_id is not null
   and not exists (select 1 from persons p where p.id = t.created_by_person_id and p.household_id = t.household_id);
update kiosk_pairing_codes t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update ledger_entries t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update list_items t set assigned_to = null
 where t.assigned_to is not null
   and not exists (select 1 from persons p where p.id = t.assigned_to and p.household_id = t.household_id);
update list_items t set checked_by = null
 where t.checked_by is not null
   and not exists (select 1 from persons p where p.id = t.checked_by and p.household_id = t.household_id);
update list_items t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update lists t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update meal_plan_entries t set cook_person_id = null
 where t.cook_person_id is not null
   and not exists (select 1 from persons p where p.id = t.cook_person_id and p.household_id = t.household_id);
update meal_plans t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update meals t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update photos t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);
update photos t set uploaded_by = null
 where t.uploaded_by is not null
   and not exists (select 1 from persons p where p.id = t.uploaded_by and p.household_id = t.household_id);
update reward_redemptions t set decided_by = null
 where t.decided_by is not null
   and not exists (select 1 from persons p where p.id = t.decided_by and p.household_id = t.household_id);
update reward_redemptions t set requested_by = null
 where t.requested_by is not null
   and not exists (select 1 from persons p where p.id = t.requested_by and p.household_id = t.household_id);
update rhythm_completions t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update rhythm_skips t set skipped_by = null
 where t.skipped_by is not null
   and not exists (select 1 from persons p where p.id = t.skipped_by and p.household_id = t.household_id);
update rhythms t set person_id = null
 where t.person_id is not null
   and not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);
update waffled_bite_devices t set created_by_person_id = null
 where t.created_by_person_id is not null
   and not exists (select 1 from persons p where p.id = t.created_by_person_id and p.household_id = t.household_id);
update waffled_bite_pairing_codes t set created_by = null
 where t.created_by is not null
   and not exists (select 1 from persons p where p.id = t.created_by and p.household_id = t.household_id);

-- ─────────────────────────────────────────────────────────────────────────────
--    2b. NOT NULL person columns on the two auth tables. Here `person_id` is the
--        authoritative link and `household_id` is a denormalized copy that no read
--        path uses to resolve a tenant — `authenticateApiKey` selects `p.household_id`
--        off a join to persons, and `findTenantBySub` does the same for identities.
--        So a mismatch here is drift in the copy, not a forged reference: re-stamp
--        the copy. Deleting instead would revoke a working API key or lock a real
--        human out of their login, and would change nothing about who they are.
-- ─────────────────────────────────────────────────────────────────────────────

update api_keys t set household_id = p.household_id
  from persons p
 where p.id = t.person_id and p.household_id <> t.household_id;
update identities t set household_id = p.household_id
  from persons p
 where p.id = t.person_id and p.household_id <> t.household_id;

-- ─────────────────────────────────────────────────────────────────────────────
--    2c. NOT NULL person columns everywhere else. `household_id` is the owning
--        tenant and the person id was client-supplied, so the row itself is the
--        forgery — it cannot be repaired into anything meaningful and it cannot be
--        nulled. Delete it. The audit's High finding is exactly this shape:
--        `POST /api/persons/:id/award` wrote `ledger_entries` rows stamped with the
--        attacker's household and the victim's person, which the victim's own kiosk
--        then displayed as their balance. That is fabricated credit; removing it
--        restores the balance the household actually earned.
--
--        Order matters: `reward_redemptions.ledger_id` → `ledger_entries` is
--        ON DELETE NO ACTION, so redemptions are cleared (or detached) first.
-- ─────────────────────────────────────────────────────────────────────────────

delete from reward_redemptions t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

-- Any surviving redemption that points at a ledger row we are about to delete has to
-- let go of it first (nullable column — it is only set once a redemption is approved).
update reward_redemptions r set ledger_id = null
 where r.ledger_id is not null
   and exists (select 1 from ledger_entries l
                where l.id = r.ledger_id
                  and not exists (select 1 from persons p
                                   where p.id = l.person_id and p.household_id = l.household_id));

delete from ledger_entries t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

delete from goal_list_members t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

delete from goal_participants t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

delete from recipe_views t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

delete from waffled_bite_devices t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

delete from waffled_bite_pairing_codes t
 where not exists (select 1 from persons p where p.id = t.person_id and p.household_id = t.household_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Swap every single-column FK for its composite form.
--
--    Constraint names are reused so the schema keeps one logical constraint per
--    reference and the Down migration is exactly symmetric.
--
--    Nullable person columns stay checkable: an FK is MATCH SIMPLE by default, which
--    skips the check when ANY column of the key is NULL. Every referencing
--    `household_id` here is NOT NULL, so the only way to skip the check is a NULL
--    person — exactly the "unassigned" case that should be allowed.
--
--    The four ON DELETE SET NULL constraints use the column-list form
--    `on delete set null (person_col)` (Postgres 15+; Waffled ships Postgres 16 in
--    both the compose stack and the native macOS runtime). Without the column list
--    Postgres would null EVERY column of the key, including the NOT NULL
--    `household_id` — turning a person delete from "unassign the row" into a hard
--    not-null violation.
-- ─────────────────────────────────────────────────────────────────────────────

alter table api_keys
  drop constraint api_keys_person_id_fkey,
  add constraint api_keys_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table calendar_accounts
  drop constraint calendar_accounts_person_id_fkey,
  add constraint calendar_accounts_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table calendar_oauth_states
  drop constraint calendar_oauth_states_person_id_fkey,
  add constraint calendar_oauth_states_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table calendars
  drop constraint calendars_person_id_fkey,
  add constraint calendars_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table chore_instances
  drop constraint chore_instances_approved_by_fkey,
  add constraint chore_instances_approved_by_fkey
    foreign key (household_id, approved_by) references persons (household_id, id);
alter table chore_instances
  drop constraint chore_instances_claimed_by_fkey,
  add constraint chore_instances_claimed_by_fkey
    foreign key (household_id, claimed_by) references persons (household_id, id);
alter table chore_instances
  drop constraint chore_instances_completed_by_fkey,
  add constraint chore_instances_completed_by_fkey
    foreign key (household_id, completed_by) references persons (household_id, id);
alter table chore_instances
  drop constraint chore_instances_person_id_fkey,
  add constraint chore_instances_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table chores
  drop constraint chores_person_id_fkey,
  add constraint chores_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table countdowns
  drop constraint countdowns_created_by_fkey,
  add constraint countdowns_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table event_goal_logs
  drop constraint event_goal_logs_created_by_fkey,
  add constraint event_goal_logs_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table event_participants
  drop constraint event_participants_person_id_fkey,
  add constraint event_participants_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table event_suggestion_dismissals
  drop constraint event_suggestion_dismissals_created_by_fkey,
  add constraint event_suggestion_dismissals_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table events
  drop constraint events_owner_person_id_fkey,
  add constraint events_owner_person_id_fkey
    foreign key (household_id, owner_person_id) references persons (household_id, id);
alter table events
  drop constraint events_person_id_fkey,
  add constraint events_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table family_night_assignments
  drop constraint family_night_assignments_person_id_fkey,
  add constraint family_night_assignments_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id) on delete set null (person_id);
alter table goal_list_members
  drop constraint goal_list_members_person_id_fkey,
  add constraint goal_list_members_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table goal_logs
  drop constraint goal_logs_created_by_fkey,
  add constraint goal_logs_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table goal_logs
  drop constraint goal_logs_person_id_fkey,
  add constraint goal_logs_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table goal_participants
  drop constraint goal_participants_person_id_fkey,
  add constraint goal_participants_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table goal_steps
  drop constraint goal_steps_done_by_fkey,
  add constraint goal_steps_done_by_fkey
    foreign key (household_id, done_by) references persons (household_id, id);
alter table health_goal_logs
  drop constraint health_goal_logs_person_id_fkey,
  add constraint health_goal_logs_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id) on delete cascade;
alter table household_invites
  drop constraint household_invites_invited_by_fkey,
  add constraint household_invites_invited_by_fkey
    foreign key (household_id, invited_by) references persons (household_id, id);
alter table households
  drop constraint fk_households_owner,
  add constraint fk_households_owner
    foreign key (id, owner_person_id) references persons (household_id, id);
alter table ics_feeds
  drop constraint ics_feeds_person_id_fkey,
  add constraint ics_feeds_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table identities
  drop constraint identities_person_id_fkey,
  add constraint identities_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table kiosk_devices
  drop constraint kiosk_devices_created_by_person_id_fkey,
  add constraint kiosk_devices_created_by_person_id_fkey
    foreign key (household_id, created_by_person_id) references persons (household_id, id);
alter table kiosk_pairing_codes
  drop constraint kiosk_pairing_codes_created_by_fkey,
  add constraint kiosk_pairing_codes_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table ledger_entries
  drop constraint ledger_entries_created_by_fkey,
  add constraint ledger_entries_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table ledger_entries
  drop constraint ledger_entries_person_id_fkey,
  add constraint ledger_entries_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table list_items
  drop constraint list_items_assigned_to_fkey,
  add constraint list_items_assigned_to_fkey
    foreign key (household_id, assigned_to) references persons (household_id, id);
alter table list_items
  drop constraint list_items_checked_by_fkey,
  add constraint list_items_checked_by_fkey
    foreign key (household_id, checked_by) references persons (household_id, id);
alter table list_items
  drop constraint list_items_created_by_fkey,
  add constraint list_items_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table lists
  drop constraint lists_created_by_fkey,
  add constraint lists_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table meal_plan_entries
  drop constraint meal_plan_entries_cook_person_id_fkey,
  add constraint meal_plan_entries_cook_person_id_fkey
    foreign key (household_id, cook_person_id) references persons (household_id, id);
alter table meal_plans
  drop constraint meal_plans_created_by_fkey,
  add constraint meal_plans_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table meals
  drop constraint meals_created_by_fkey,
  add constraint meals_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table photos
  drop constraint photos_created_by_fkey,
  add constraint photos_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table photos
  drop constraint photos_uploaded_by_fkey,
  add constraint photos_uploaded_by_fkey
    foreign key (household_id, uploaded_by) references persons (household_id, id);
alter table recipe_views
  drop constraint recipe_views_person_id_fkey,
  add constraint recipe_views_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id) on delete cascade;
alter table reward_redemptions
  drop constraint reward_redemptions_decided_by_fkey,
  add constraint reward_redemptions_decided_by_fkey
    foreign key (household_id, decided_by) references persons (household_id, id);
alter table reward_redemptions
  drop constraint reward_redemptions_person_id_fkey,
  add constraint reward_redemptions_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table reward_redemptions
  drop constraint reward_redemptions_requested_by_fkey,
  add constraint reward_redemptions_requested_by_fkey
    foreign key (household_id, requested_by) references persons (household_id, id);
alter table rhythm_completions
  drop constraint rhythm_completions_person_id_fkey,
  add constraint rhythm_completions_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id) on delete set null (person_id);
alter table rhythm_skips
  drop constraint rhythm_skips_skipped_by_fkey,
  add constraint rhythm_skips_skipped_by_fkey
    foreign key (household_id, skipped_by) references persons (household_id, id) on delete set null (skipped_by);
alter table rhythms
  drop constraint rhythms_person_id_fkey,
  add constraint rhythms_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id) on delete set null (person_id);
alter table waffled_bite_devices
  drop constraint waffled_bite_devices_created_by_person_id_fkey,
  add constraint waffled_bite_devices_created_by_person_id_fkey
    foreign key (household_id, created_by_person_id) references persons (household_id, id);
alter table waffled_bite_devices
  drop constraint waffled_bite_devices_person_id_fkey,
  add constraint waffled_bite_devices_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);
alter table waffled_bite_pairing_codes
  drop constraint waffled_bite_pairing_codes_created_by_fkey,
  add constraint waffled_bite_pairing_codes_created_by_fkey
    foreign key (household_id, created_by) references persons (household_id, id);
alter table waffled_bite_pairing_codes
  drop constraint waffled_bite_pairing_codes_person_id_fkey,
  add constraint waffled_bite_pairing_codes_person_id_fkey
    foreign key (household_id, person_id) references persons (household_id, id);

-- Down Migration
-- Restores the original single-column foreign keys, names and delete actions.
-- The data repair in step 2 is NOT reversed — the rows it removed were forged and
-- the attributions it nulled pointed outside the household.

alter table api_keys
  drop constraint api_keys_person_id_fkey,
  add constraint api_keys_person_id_fkey
    foreign key (person_id) references persons (id);
alter table calendar_accounts
  drop constraint calendar_accounts_person_id_fkey,
  add constraint calendar_accounts_person_id_fkey
    foreign key (person_id) references persons (id);
alter table calendar_oauth_states
  drop constraint calendar_oauth_states_person_id_fkey,
  add constraint calendar_oauth_states_person_id_fkey
    foreign key (person_id) references persons (id);
alter table calendars
  drop constraint calendars_person_id_fkey,
  add constraint calendars_person_id_fkey
    foreign key (person_id) references persons (id);
alter table chore_instances
  drop constraint chore_instances_approved_by_fkey,
  add constraint chore_instances_approved_by_fkey
    foreign key (approved_by) references persons (id);
alter table chore_instances
  drop constraint chore_instances_claimed_by_fkey,
  add constraint chore_instances_claimed_by_fkey
    foreign key (claimed_by) references persons (id);
alter table chore_instances
  drop constraint chore_instances_completed_by_fkey,
  add constraint chore_instances_completed_by_fkey
    foreign key (completed_by) references persons (id);
alter table chore_instances
  drop constraint chore_instances_person_id_fkey,
  add constraint chore_instances_person_id_fkey
    foreign key (person_id) references persons (id);
alter table chores
  drop constraint chores_person_id_fkey,
  add constraint chores_person_id_fkey
    foreign key (person_id) references persons (id);
alter table countdowns
  drop constraint countdowns_created_by_fkey,
  add constraint countdowns_created_by_fkey
    foreign key (created_by) references persons (id);
alter table event_goal_logs
  drop constraint event_goal_logs_created_by_fkey,
  add constraint event_goal_logs_created_by_fkey
    foreign key (created_by) references persons (id);
alter table event_participants
  drop constraint event_participants_person_id_fkey,
  add constraint event_participants_person_id_fkey
    foreign key (person_id) references persons (id);
alter table event_suggestion_dismissals
  drop constraint event_suggestion_dismissals_created_by_fkey,
  add constraint event_suggestion_dismissals_created_by_fkey
    foreign key (created_by) references persons (id);
alter table events
  drop constraint events_owner_person_id_fkey,
  add constraint events_owner_person_id_fkey
    foreign key (owner_person_id) references persons (id);
alter table events
  drop constraint events_person_id_fkey,
  add constraint events_person_id_fkey
    foreign key (person_id) references persons (id);
alter table family_night_assignments
  drop constraint family_night_assignments_person_id_fkey,
  add constraint family_night_assignments_person_id_fkey
    foreign key (person_id) references persons (id) on delete set null;
alter table goal_list_members
  drop constraint goal_list_members_person_id_fkey,
  add constraint goal_list_members_person_id_fkey
    foreign key (person_id) references persons (id);
alter table goal_logs
  drop constraint goal_logs_created_by_fkey,
  add constraint goal_logs_created_by_fkey
    foreign key (created_by) references persons (id);
alter table goal_logs
  drop constraint goal_logs_person_id_fkey,
  add constraint goal_logs_person_id_fkey
    foreign key (person_id) references persons (id);
alter table goal_participants
  drop constraint goal_participants_person_id_fkey,
  add constraint goal_participants_person_id_fkey
    foreign key (person_id) references persons (id);
alter table goal_steps
  drop constraint goal_steps_done_by_fkey,
  add constraint goal_steps_done_by_fkey
    foreign key (done_by) references persons (id);
alter table health_goal_logs
  drop constraint health_goal_logs_person_id_fkey,
  add constraint health_goal_logs_person_id_fkey
    foreign key (person_id) references persons (id) on delete cascade;
alter table household_invites
  drop constraint household_invites_invited_by_fkey,
  add constraint household_invites_invited_by_fkey
    foreign key (invited_by) references persons (id);
alter table households
  drop constraint fk_households_owner,
  add constraint fk_households_owner
    foreign key (owner_person_id) references persons (id);
alter table ics_feeds
  drop constraint ics_feeds_person_id_fkey,
  add constraint ics_feeds_person_id_fkey
    foreign key (person_id) references persons (id);
alter table identities
  drop constraint identities_person_id_fkey,
  add constraint identities_person_id_fkey
    foreign key (person_id) references persons (id);
alter table kiosk_devices
  drop constraint kiosk_devices_created_by_person_id_fkey,
  add constraint kiosk_devices_created_by_person_id_fkey
    foreign key (created_by_person_id) references persons (id);
alter table kiosk_pairing_codes
  drop constraint kiosk_pairing_codes_created_by_fkey,
  add constraint kiosk_pairing_codes_created_by_fkey
    foreign key (created_by) references persons (id);
alter table ledger_entries
  drop constraint ledger_entries_created_by_fkey,
  add constraint ledger_entries_created_by_fkey
    foreign key (created_by) references persons (id);
alter table ledger_entries
  drop constraint ledger_entries_person_id_fkey,
  add constraint ledger_entries_person_id_fkey
    foreign key (person_id) references persons (id);
alter table list_items
  drop constraint list_items_assigned_to_fkey,
  add constraint list_items_assigned_to_fkey
    foreign key (assigned_to) references persons (id);
alter table list_items
  drop constraint list_items_checked_by_fkey,
  add constraint list_items_checked_by_fkey
    foreign key (checked_by) references persons (id);
alter table list_items
  drop constraint list_items_created_by_fkey,
  add constraint list_items_created_by_fkey
    foreign key (created_by) references persons (id);
alter table lists
  drop constraint lists_created_by_fkey,
  add constraint lists_created_by_fkey
    foreign key (created_by) references persons (id);
alter table meal_plan_entries
  drop constraint meal_plan_entries_cook_person_id_fkey,
  add constraint meal_plan_entries_cook_person_id_fkey
    foreign key (cook_person_id) references persons (id);
alter table meal_plans
  drop constraint meal_plans_created_by_fkey,
  add constraint meal_plans_created_by_fkey
    foreign key (created_by) references persons (id);
alter table meals
  drop constraint meals_created_by_fkey,
  add constraint meals_created_by_fkey
    foreign key (created_by) references persons (id);
alter table photos
  drop constraint photos_created_by_fkey,
  add constraint photos_created_by_fkey
    foreign key (created_by) references persons (id);
alter table photos
  drop constraint photos_uploaded_by_fkey,
  add constraint photos_uploaded_by_fkey
    foreign key (uploaded_by) references persons (id);
alter table recipe_views
  drop constraint recipe_views_person_id_fkey,
  add constraint recipe_views_person_id_fkey
    foreign key (person_id) references persons (id) on delete cascade;
alter table reward_redemptions
  drop constraint reward_redemptions_decided_by_fkey,
  add constraint reward_redemptions_decided_by_fkey
    foreign key (decided_by) references persons (id);
alter table reward_redemptions
  drop constraint reward_redemptions_person_id_fkey,
  add constraint reward_redemptions_person_id_fkey
    foreign key (person_id) references persons (id);
alter table reward_redemptions
  drop constraint reward_redemptions_requested_by_fkey,
  add constraint reward_redemptions_requested_by_fkey
    foreign key (requested_by) references persons (id);
alter table rhythm_completions
  drop constraint rhythm_completions_person_id_fkey,
  add constraint rhythm_completions_person_id_fkey
    foreign key (person_id) references persons (id) on delete set null;
alter table rhythm_skips
  drop constraint rhythm_skips_skipped_by_fkey,
  add constraint rhythm_skips_skipped_by_fkey
    foreign key (skipped_by) references persons (id) on delete set null;
alter table rhythms
  drop constraint rhythms_person_id_fkey,
  add constraint rhythms_person_id_fkey
    foreign key (person_id) references persons (id) on delete set null;
alter table waffled_bite_devices
  drop constraint waffled_bite_devices_created_by_person_id_fkey,
  add constraint waffled_bite_devices_created_by_person_id_fkey
    foreign key (created_by_person_id) references persons (id);
alter table waffled_bite_devices
  drop constraint waffled_bite_devices_person_id_fkey,
  add constraint waffled_bite_devices_person_id_fkey
    foreign key (person_id) references persons (id);
alter table waffled_bite_pairing_codes
  drop constraint waffled_bite_pairing_codes_created_by_fkey,
  add constraint waffled_bite_pairing_codes_created_by_fkey
    foreign key (created_by) references persons (id);
alter table waffled_bite_pairing_codes
  drop constraint waffled_bite_pairing_codes_person_id_fkey,
  add constraint waffled_bite_pairing_codes_person_id_fkey
    foreign key (person_id) references persons (id);

alter table persons
  drop constraint persons_household_id_id_key;
