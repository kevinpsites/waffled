package app.waffled.core.sync

import com.powersync.db.schema.Column
import com.powersync.db.schema.Schema
import com.powersync.db.schema.Table

/**
 * The on-device SQLite mirror.
 *
 * ⚠️ KEEP IN SYNC with the server sync rules
 * (`infra/compose/powersync/sync-config.yaml`), the web client schema
 * (`apps/web/src/lib/powersync/schema.ts`) and iOS (`Sync/SyncSchema.swift`).
 * `id` is the implicit text primary key, so it is never listed.
 *
 * PowerSync downloads only the tables declared here, and the server sends every column
 * (`SELECT *`) — so a column missing from this file is silently dropped rather than
 * erroring. `SyncSchemaParityTest` locks it against the web schema.
 *
 * Only these five tables are synced. Everything else in Waffled — chores, goals, meals,
 * lists, pantry, rewards, photos, Family Night, Waffled-Bites — is online-only REST.
 */
object WaffledSyncSchema {

    val schema = Schema(
        Table(
            name = "households",
            columns = listOf(
                Column.text("name"),
                Column.text("timezone"),
                Column.text("week_start"),
            ),
        ),
        Table(
            name = "persons",
            columns = listOf(
                Column.text("household_id"),
                Column.text("name"),
                Column.text("color_hex"),
                Column.text("avatar_emoji"),
                Column.text("member_type"),
                Column.integer("sort_order"),
                Column.text("created_at"),
            ),
        ),
        Table(
            name = "events",
            columns = listOf(
                Column.text("household_id"),
                Column.text("calendar_id"),
                Column.text("title"),
                Column.text("description"),
                Column.text("location"),
                Column.text("starts_at"),
                Column.text("ends_at"),
                // SQLite has no boolean — 0/1.
                Column.integer("all_day"),
                // Waffled-owned "show a countdown" flag.
                Column.integer("is_countdown"),
                Column.text("timezone"),
                Column.text("status"),
                Column.text("person_id"),
                // Calendar↔goal bridge. Present on web but NOT in the iOS schema.
                Column.text("goal_id"),
                Column.text("goal_step_id"),
                Column.text("origin"),
                Column.text("origin_ref_id"),
                // Non-null marks a recurring master (its occurrences render instead).
                Column.text("rrule"),
                // 'family' (shared kiosk) | 'personal' (only owner_person_id sees it).
                Column.text("visibility"),
                Column.text("owner_person_id"),
                Column.text("updated_at"),
                // The rhythm this slot was booked for. Read-only here: the server treats an
                // absent rhythm_id on upload as "leave it alone", and nothing writes it locally.
                Column.text("rhythm_id"),
            ),
        ),
        Table(
            name = "event_participants",
            columns = listOf(
                Column.text("household_id"),
                Column.text("event_id"),
                Column.text("person_id"),
            ),
        ),
        // Materialised occurrences of a recurring master. Read as plain dated rows — no
        // client-side RRULE expansion; a server worker keeps them in sync.
        Table(
            name = "event_occurrences",
            columns = listOf(
                Column.text("household_id"),
                Column.text("event_id"),
                Column.text("override_id"),
                Column.text("original_start"),
                Column.text("person_id"),
                Column.text("title"),
                Column.text("location"),
                Column.text("starts_at"),
                Column.text("ends_at"),
                Column.integer("all_day"),
                Column.text("starts_on"),
                Column.text("visibility"),
                Column.text("owner_person_id"),
            ),
        ),
    )
}
