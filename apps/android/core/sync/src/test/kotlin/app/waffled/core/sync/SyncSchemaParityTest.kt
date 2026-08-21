package app.waffled.core.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ⚠️ KEEP IN SYNC — the local PowerSync schema now exists in FOUR places:
 *   1. `infra/compose/powersync/sync-config.yaml`  (server sync rules — `SELECT *`)
 *   2. `apps/web/src/lib/powersync/schema.ts`      (source of truth for clients)
 *   3. `apps/ios/Sources/Waffled/Sync/SyncSchema.swift`
 *   4. here
 *
 * The server sends every column (`SELECT *`); the CLIENT schema decides which ones get
 * materialised locally, so an omission here is a silent data loss, not an error. That is
 * exactly the drift this test exists to catch.
 *
 * The expectation below is transcribed from the **web** schema, which is the declared
 * source of truth.
 *
 * NOTE: iOS is currently missing `goal_id`, `goal_step_id` and `origin_ref_id` on
 * `events` — the calendar↔goal bridge fields. Android deliberately matches web, not iOS.
 */
class SyncSchemaParityTest {

    private val webSchema: Map<String, Set<String>> = mapOf(
        "households" to setOf("name", "timezone", "week_start"),
        "persons" to setOf(
            "household_id", "name", "color_hex", "avatar_emoji",
            "member_type", "sort_order", "created_at",
        ),
        "events" to setOf(
            "household_id", "calendar_id", "title", "description", "location",
            "starts_at", "ends_at", "all_day", "is_countdown", "timezone", "status",
            "person_id", "goal_id", "goal_step_id", "origin", "origin_ref_id",
            "rrule", "visibility", "owner_person_id", "updated_at",
        ),
        "event_participants" to setOf("household_id", "event_id", "person_id"),
        "event_occurrences" to setOf(
            "household_id", "event_id", "override_id", "original_start", "person_id",
            "title", "location", "starts_at", "ends_at", "all_day", "starts_on",
            "visibility", "owner_person_id",
        ),
    )

    @Test
    fun tableSetMatchesTheWebClientSchema() {
        assertEquals(
            webSchema.keys.sorted(),
            WaffledSyncSchema.schema.tables.map { it.name }.sorted(),
        )
    }

    @Test
    fun everyTablesColumnSetMatchesTheWebClientSchema() {
        WaffledSyncSchema.schema.tables.forEach { table ->
            val expected = webSchema.getValue(table.name)
            val actual = table.columns.map { it.name }.toSet()
            assertEquals(expected, actual, "column drift in `${table.name}`")
        }
    }

    @Test
    fun idIsNeverDeclaredBecauseItIsTheImplicitPrimaryKey() {
        WaffledSyncSchema.schema.tables.forEach { table ->
            assertTrue(
                table.columns.none { it.name == "id" },
                "`${table.name}` declares `id`, but it is the implicit text primary key",
            )
        }
    }

    @Test
    fun booleanishColumnsAreIntegersBecauseSqliteHasNoBool() {
        val events = WaffledSyncSchema.schema.tables.first { it.name == "events" }
        listOf("all_day", "is_countdown").forEach { name ->
            val col = events.columns.first { it.name == name }
            assertEquals(
                "INTEGER",
                col.type.toString().uppercase(),
                "`$name` must be INTEGER — SQLite has no boolean",
            )
        }
    }

    @Test
    fun onlyFiveTablesAreSyncedEverythingElseIsRest() {
        // Deliberate: offline-first covers Calendar + People only. Chores, goals, meals,
        // lists, pantry, rewards and photos are all online-only REST, which is why the
        // port needs no offline write support for them.
        assertEquals(5, WaffledSyncSchema.schema.tables.size)
    }
}
