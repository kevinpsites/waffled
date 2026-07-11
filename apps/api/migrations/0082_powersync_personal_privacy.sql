-- Up Migration
-- Legacy PowerSync Sync Rules cannot join event_participants back to events while
-- evaluating CDC rows. Denormalize the event's privacy scope so participant rows
-- can use the same server-side owner filter as events and occurrences.

alter table event_participants
  add column visibility text not null default 'family'
    check (visibility in ('family', 'personal')),
  add column owner_person_id uuid references persons(id);

update event_participants ep
   set visibility = e.visibility,
       owner_person_id = e.owner_person_id
  from events e
 where ep.event_id = e.id;

create function stamp_event_participant_scope() returns trigger
language plpgsql as $$
begin
  select e.visibility, e.owner_person_id
    into new.visibility, new.owner_person_id
    from events e
   where e.id = new.event_id;
  return new;
end;
$$;

create trigger trg_event_participant_scope
  before insert or update of event_id on event_participants
  for each row execute function stamp_event_participant_scope();

create function propagate_event_participant_scope() returns trigger
language plpgsql as $$
begin
  if new.visibility is distinct from old.visibility
     or new.owner_person_id is distinct from old.owner_person_id then
    update event_participants
       set visibility = new.visibility,
           owner_person_id = new.owner_person_id
     where event_id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_event_participant_scope_from_event
  after update of visibility, owner_person_id on events
  for each row execute function propagate_event_participant_scope();

-- Down Migration

drop trigger if exists trg_event_participant_scope_from_event on events;
drop function if exists propagate_event_participant_scope();
drop trigger if exists trg_event_participant_scope on event_participants;
drop function if exists stamp_event_participant_scope();
alter table event_participants drop column if exists owner_person_id;
alter table event_participants drop column if exists visibility;
