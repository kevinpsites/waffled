-- Up Migration
-- Keep the user-visible meaning of a materialized chore occurrence independent
-- from later edits or deletion of its recurring template.

alter table chores
  add column if not exists recurrence_start_on date;

alter table chore_instances
  add column if not exists title_snapshot text,
  add column if not exists emoji_snapshot text,
  add column if not exists due_time_snapshot time,
  add column if not exists rrule_snapshot text;

create or replace function snapshot_chore_instance_fields()
returns trigger language plpgsql as $$
begin
  select coalesce(new.title_snapshot, c.title),
         coalesce(new.emoji_snapshot, c.emoji),
         coalesce(new.due_time_snapshot, c.due_time),
         coalesce(new.rrule_snapshot, c.rrule)
    into new.title_snapshot, new.emoji_snapshot,
         new.due_time_snapshot, new.rrule_snapshot
    from chores c
   where c.id = new.chore_id;
  return new;
end;
$$;

drop trigger if exists trg_chore_instance_snapshot on chore_instances;
-- Application materialization supplies the complete snapshot tuple directly. The
-- non-null title is the sentinel for that fast path; direct/legacy inserts that
-- omit snapshots still fall back to the template lookup.
create trigger trg_chore_instance_snapshot
  before insert on chore_instances
  for each row
  when (new.title_snapshot is null)
  execute function snapshot_chore_instance_fields();

update chore_instances ci
   set title_snapshot = c.title,
       emoji_snapshot = c.emoji,
       due_time_snapshot = c.due_time,
       rrule_snapshot = c.rrule
  from chores c
 where c.id = ci.chore_id
   and ci.title_snapshot is null;

alter table chore_instances
  alter column title_snapshot set not null;

-- Down Migration

drop trigger if exists trg_chore_instance_snapshot on chore_instances;
drop function if exists snapshot_chore_instance_fields();

alter table chore_instances
  drop column if exists rrule_snapshot,
  drop column if exists due_time_snapshot,
  drop column if exists emoji_snapshot,
  drop column if exists title_snapshot;

alter table chores
  drop column if exists recurrence_start_on;
