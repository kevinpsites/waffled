-- Up Migration
-- PowerSync is gone. Drop its publication and any idle replication slot it left on the
-- server, and put the tables it forced to REPLICA IDENTITY FULL back to the default.
-- An active slot is skipped (dropping it would error); stopping PowerSync releases it.

drop publication if exists powersync;

do $$
declare s record;
begin
  for s in
    select slot_name from pg_replication_slots
    where slot_type = 'logical' and slot_name like 'powersync%' and not active
  loop
    perform pg_drop_replication_slot(s.slot_name);
  end loop;
end $$;

alter table events replica identity default;
alter table event_participants replica identity default;
alter table event_occurrences replica identity default;
alter table households replica identity default;
alter table persons replica identity default;

-- Down Migration
-- Re-creating the PowerSync objects is not supported.
