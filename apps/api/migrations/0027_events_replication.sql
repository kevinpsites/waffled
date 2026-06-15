-- Up Migration
-- Hop 2 (realtime to clients): publish calendar events so PowerSync streams them
-- to the kiosk / app, instead of clients polling /api/events. The scheduled poll
-- (hop 1) writes Google changes into events; logical replication then fans them
-- out live. REPLICA IDENTITY FULL so updates/deletes carry the old row PowerSync
-- needs to maintain client bucket state (matches households/persons in 0003).
-- A matching `data:` query is added to the household bucket in sync-config.yaml.

alter table events replica identity full;
alter table event_participants replica identity full;

alter publication powersync add table events;
alter publication powersync add table event_participants;

-- Down Migration

alter publication powersync drop table event_participants;
alter publication powersync drop table events;

alter table event_participants replica identity default;
alter table events replica identity default;
