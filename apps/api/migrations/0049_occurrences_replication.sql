-- Up Migration
-- Publish materialized recurrence occurrences so PowerSync streams them to clients
-- (kiosk/iOS) alongside single events. Clients render event_occurrences as plain
-- dated rows (UNION with single events) — no RRULE engine on-device. REPLICA
-- IDENTITY FULL so updates/deletes carry the old row PowerSync needs for bucket
-- state (matches events/participants in 0027). Occurrences are server-written only
-- (the expansion worker), so there's no client CRUD path. A matching `data:` query
-- is added to the household bucket in sync-config.yaml.

alter table event_occurrences replica identity full;
alter publication powersync add table event_occurrences;

-- Down Migration

alter publication powersync drop table event_occurrences;
alter table event_occurrences replica identity default;
