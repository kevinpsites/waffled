---
title: Database & migrations
description: The Postgres schema, migration conventions, and how multi-tenancy works.
---

Waffled's source of truth is a single **Postgres 16** database. Schema changes are plain SQL
migrations, forward-only and idempotent, applied automatically on `up` and `upgrade`.

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
./waffled migrate        # apply from the host (cd apps/api && npm run migrate)
```

On `./waffled up` a one-shot **`migrate`** compose service runs first, so the schema — including
the PowerSync publication — exists before the api and PowerSync start. Migrations are effectively
**forward-only** in operation: `./waffled upgrade` re-runs `up`, and a database backup is the
rollback point (see [Upgrading](/operations/upgrading/)). Re-running is always safe.

### Adding a migration

1. Create `apps/api/migrations/NNNN_your_change.sql` with the `-- Up Migration` /
   `-- Down Migration` markers. Keep the up SQL idempotent.
2. If the new tables must **sync offline to iOS**, also `ALTER PUBLICATION powersync ADD TABLE …`
   and add a matching `data:` query to `infra/compose/powersync/sync-config.yaml`.
3. `./waffled migrate` (or `./waffled up`) to apply. Tests provision a throwaway Postgres from
   migrations alone, so a broken migration fails CI fast.

Notable migrations for orientation: `0001_base` (the shared spine + `set_updated_at()` trigger),
`0003_powersync_publication` (replica identity + `create publication powersync`), and later
domain migrations that `ALTER PUBLICATION powersync ADD TABLE …` as each offline domain lands.

## Table conventions

Every tenant-scoped table shares a common spine (see the [full schema reference](https://github.com/kevinpsites/waffled/blob/main/docs/DATA_MODEL.md)):

| Column | Purpose |
|---|---|
| `id uuid` | Primary key, `default gen_random_uuid()` — **but usually client-generated** (offline-mintable, required by PowerSync). |
| `household_id uuid` | The tenant scope — `not null references households(id)`. |
| `created_at` / `updated_at` | Timestamps; `updated_at` maintained by a trigger. |
| `deleted_at` | Soft-delete tombstone — rows are never hard-deleted; queries filter `WHERE deleted_at IS NULL` (with partial indexes). |

Because IDs are client-generated UUIDs, an offline client can mint a row and sync it later without
a round-trip — the key requirement PowerSync imposes.

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
2. **PowerSync:** the sync rules (`infra/compose/powersync/sync-config.yaml`) define **one bucket
   per household** — `parameters: SELECT request.jwt() ->> 'household_id'`, and each `data:` query
   is `WHERE household_id = bucket.household_id AND deleted_at IS NULL`. A client physically only
   receives its own household's rows.

## Direct access

```bash
./waffled psql          # interactive psql on the database
./waffled backup        # dump now (see Backup & restore)
```

`./waffled psql` and the break-glass `./waffled admin` commands run inside the container with full
DB access — the security model is that host/SSH access equals trust.
