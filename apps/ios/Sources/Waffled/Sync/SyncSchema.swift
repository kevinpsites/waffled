import PowerSync

/// The on-device SQLite mirror — must match the server sync rules
/// (`infra/compose/powersync/sync-config.yaml`) and the web client schema
/// (`apps/web/src/lib/powersync/schema.ts`). PowerSync downloads only the tables
/// declared here; `id` is the implicit text primary key, so it's never listed.
enum SyncSchema {
    static let schema = Schema(tables: [
        Table(name: "households", columns: [
            .text("name"),
            .text("timezone"),
            .text("week_start"),
        ]),
        Table(name: "persons", columns: [
            .text("household_id"),
            .text("name"),
            .text("color_hex"),
            .text("avatar_emoji"),
            .text("member_type"),
            .integer("sort_order"),
            .text("created_at"),
        ]),
        Table(name: "events", columns: [
            .text("household_id"),
            .text("calendar_id"),
            .text("title"),
            .text("description"),
            .text("location"),
            .text("starts_at"),
            .text("ends_at"),
            .integer("all_day"),
            // Waffled-owned "show a countdown" flag (SQLite has no bool; 0/1).
            .integer("is_countdown"),
            .text("timezone"),
            .text("status"),
            .text("person_id"),
            .text("origin"),
            // non-null marks a recurring master (its occurrences render instead)
            .text("rrule"),
            // 'family' (shared kiosk) | 'personal' (only owner_person_id sees it)
            .text("visibility"),
            .text("owner_person_id"),
            .text("updated_at"),
        ]),
        Table(name: "event_participants", columns: [
            .text("household_id"),
            .text("event_id"),
            .text("person_id"),
        ]),
        // Materialized occurrences of a recurring master (event_id). Read as plain
        // dated rows (no client-side RRULE expansion); the server worker keeps them
        // in sync. Mirrors the web client schema's `event_occurrences` table.
        Table(name: "event_occurrences", columns: [
            .text("household_id"),
            .text("event_id"),
            .text("override_id"),
            .text("original_start"),
            .text("person_id"),
            .text("title"),
            .text("location"),
            .text("starts_at"),
            .text("ends_at"),
            .integer("all_day"),
            .text("starts_on"),
            .text("visibility"),
            .text("owner_person_id"),
        ]),
    ])
}
