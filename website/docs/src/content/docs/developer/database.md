---
title: Database & migrations
description: The Postgres schema, migration conventions, and how multi-tenancy works.
---

Waffled's source of truth is a single **Postgres 16** database. Schema changes are plain SQL
migrations, forward-only and idempotent, applied automatically every time the app starts.

## Migrations

Migrations live in **`apps/api/migrations/`** as flat `.sql` files.

- **Naming:** `NNNN_name.sql` (e.g. `0001_base.sql`, `0073_reward_category.sql`).
- **Format:** each file has an `-- Up Migration` marker (first meaningful line) and a
  `-- Down Migration` marker splitting the up/down SQL. DDL is written idempotently
  (`create ... if not exists`) so a bare database is provisioned by migrations alone.
- **Runner:** [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate); applied state is
  tracked in the `pgmigrations` table.

### Running them

```bash
docker compose up -d       # the waffled container migrates on start
cd apps/api && npm run migrate   # or apply from the host against DATABASE_URL
```

The app takes an advisory lock and applies pending migrations before it serves traffic.
Migrations are effectively **forward-only** in operation: a database backup is the rollback
point (see [Upgrading](/operations/upgrading/)). Re-running is always safe.

### Adding a migration

1. Create `apps/api/migrations/NNNN_your_change.sql` with the `-- Up Migration` /
   `-- Down Migration` markers. Keep the up SQL idempotent.
2. Never edit an applied migration; fix forward with a new number.
3. `npm run migrate` (or restart the stack) to apply. Tests provision a throwaway Postgres from
   migrations alone, so a broken migration fails CI fast.

Notable migration for orientation: `0001_base` (the shared spine + `set_updated_at()` trigger).
Historical PowerSync migrations stay in the folder; a later one drops the publication and any
replication slots.

## Table conventions

Every tenant-scoped table shares a common spine (see the [full schema reference](https://github.com/evan-ribbey/waffled-remix/blob/main/docs/DATA_MODEL.md)):

| Column | Purpose |
|---|---|
| `id uuid` | Primary key, `default gen_random_uuid()` — **clients may supply their own**. |
| `household_id uuid` | The tenant scope — `not null references households(id)`. |
| `created_at` / `updated_at` | Timestamps; `updated_at` maintained by a trigger. |
| `deleted_at` | Soft-delete tombstone — rows are never hard-deleted; queries filter `WHERE deleted_at IS NULL` (with partial indexes). |

## The domains

The schema is organized by feature domain, each roughly one migration family:

- **Identity:** `households`, `persons`, `identities`, `accounts` — the auth spine.
- **Calendar:** `events`, `event_participants`, `event_occurrences`, `calendars`, `countdowns`.
- **Chores & economy:** `chores`, `ledger_entries` (append-only), `rewards`, currencies.
- **Goals:** goals, goal lists, logs, milestones.
- **Meals & lists:** `recipes`, meal plans, `lists`, list items.
- **Pantry, photos, family night, kiosk devices, api keys** — the remaining modules.

## Multi-tenancy

Isolation is enforced at two layers so a bug in one is caught by the other:

1. **API:** the auth gate (`src/app.ts`) resolves a tenant (household + person) from the JWT
   `household_id` claim; [route guards](/concepts/permissions/) re-assert it per handler.
2. **Postgres:** every reference to a person is a **composite foreign key** —
   `foreign key (household_id, person_id) references persons (household_id, id)`, backed by a
   `unique (household_id, id)` key on `persons` (migration `0104`). A single-column FK proves only
   that the person exists; the composite one proves they are in the *same household as the row*,
   so a cross-household reference is rejected by the database even if a handler forgets to check.

### Writing a new person reference

Give the table a `not null household_id` and write the FK as the composite form, never
`references persons(id)`:

```sql
person_id uuid references persons(id),  -- ❌ any household's person satisfies this
...
foreign key (household_id, person_id) references persons (household_id, id)  -- ✅
```

A nullable person column stays legal: an FK is `MATCH SIMPLE`, so the check is skipped when the
person is `NULL` — which is why the `household_id` half must be `NOT NULL`, or the constraint has
nothing to bite on. If the reference needs `on delete set null`, use the column-list form
`on delete set null (person_id)`; the bare form would null `household_id` too and turn a person
delete into a not-null violation.

Three references are deliberately exempt because they have no household column to compose with:
`refresh_tokens.person_id` and `auth_handoffs.person_id` (auth-internal — the value is the
authenticated person, never client-supplied) and `meal_recipes.cook_person_id` (a join table keyed
`(meal_id, recipe_id)`, whose household is reached through `meals`).

## Direct access

```bash
docker compose exec postgres psql -U waffled waffled   # interactive psql on the database
docker compose exec -u postgres backup waffled-backup  # dump now (see Backup & restore)
```

`psql` and the break-glass admin commands run inside the containers with full DB access — the
security model is that host/SSH access equals trust.
