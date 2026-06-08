-- Up Migration
-- PowerSync replicates from a Postgres logical-replication publication. We publish
-- only the tables we sync to clients today; later domains ALTER PUBLICATION to add
-- their tables. REPLICA IDENTITY FULL makes updates/deletes carry the full old row,
-- which PowerSync needs to maintain client-side bucket state.
-- (wal_level=logical is set on the server in docker-compose; creating the
-- publication object itself does not require it, so migrations stay portable.)

alter table households replica identity full;
alter table persons replica identity full;

create publication powersync for table households, persons;

-- Down Migration

drop publication if exists powersync;
alter table persons replica identity default;
alter table households replica identity default;
