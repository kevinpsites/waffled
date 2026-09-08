-- Up Migration
-- `access_expires_at` was introduced in 0102 as an exact instant. Preserve that
-- enforcement column, but make the household-local final day the canonical
-- policy value so changing a household timezone does not change the chosen day.

-- Take every deployment lock up front, in the same direction as runtime work:
-- household -> invite -> person. Besides keeping timezone writes out of the
-- backfill window, taking the invite table before persons avoids deadlocking an
-- in-flight pre-0103 accept transaction that already holds its invite row and is
-- about to look up/lock the membership row.
lock table households in share mode;
lock table household_invites in access exclusive mode;
lock table persons in access exclusive mode;

-- Fail before changing the schema when an older deployment has stored a timezone
-- PostgreSQL cannot use for civil-date conversion. The application now validates
-- every write boundary, but legacy rows need an actionable repair message instead
-- of failing partway through the backfill with an opaque AT TIME ZONE error.
do $$
declare
  household_row record;
  timezone_error text;
begin
  for household_row in
    select id, timezone from households order by id
  loop
    begin
      perform timestamp '2000-01-01 00:00:00' at time zone household_row.timezone;
    exception when invalid_parameter_value then
      timezone_error := sqlerrm;
      raise exception using
        errcode = '22023',
        message = format(
          'Cannot add temporary-access civil dates: household %s has invalid timezone %L.',
          household_row.id,
          household_row.timezone
        ),
        detail = timezone_error,
        hint = 'Update households.timezone to a valid timezone and retry the migration.';
    end;
  end loop;
end $$;

alter table persons
  add column access_ends_on date;

alter table household_invites
  add column access_ends_on date;

-- Upgrade existing exact instants to civil dates in each row's household zone.
-- The prior local date is the latest *complete* civil day before an arbitrary
-- legacy instant. Shipped web/iOS clients were the one exception: they encoded the
-- selected final day as 23:59:59(.999) in local time. Preserve that recognizable
-- end-of-day shape as the same civil date; do not round arbitrary daytime values
-- forward.
update persons p
   set access_ends_on = case
         when (p.access_expires_at at time zone h.timezone)::time >= time '23:59:59'
           then (p.access_expires_at at time zone h.timezone)::date
         else (p.access_expires_at at time zone h.timezone)::date - 1
       end,
       access_expires_at = (
         (case
            when (p.access_expires_at at time zone h.timezone)::time >= time '23:59:59'
              then (p.access_expires_at at time zone h.timezone)::date + 1
            else (p.access_expires_at at time zone h.timezone)::date
          end)::timestamp
         at time zone h.timezone
       )
  from households h
 where h.id = p.household_id
   and p.access_expires_at is not null;

update household_invites hi
   set access_ends_on = case
         when (hi.access_expires_at at time zone h.timezone)::time >= time '23:59:59'
           then (hi.access_expires_at at time zone h.timezone)::date
         else (hi.access_expires_at at time zone h.timezone)::date - 1
       end,
       access_expires_at = (
         (case
            when (hi.access_expires_at at time zone h.timezone)::time >= time '23:59:59'
              then (hi.access_expires_at at time zone h.timezone)::date + 1
            else (hi.access_expires_at at time zone h.timezone)::date
          end)::timestamp
         at time zone h.timezone
       )
  from households h
 where h.id = hi.household_id
   and hi.access_expires_at is not null;

-- The two representations are one value, not independently editable fields.
-- A trigger below accepts either the canonical date or the legacy instant and
-- rewrites the row to an internally consistent pair before these checks run.
alter table persons
  add constraint chk_person_access_window_pair
  check ((access_ends_on is null) = (access_expires_at is null)),
  add constraint chk_person_access_end_role
  check (access_ends_on is null or member_type in ('caregiver', 'guest'));

alter table household_invites
  add constraint chk_invite_access_window_pair
  check ((access_ends_on is null) = (access_expires_at is null)),
  add constraint chk_invite_access_end_role
  check (access_ends_on is null or member_type in ('caregiver', 'guest'));

-- Expired pending invitations are already unusable and invisible to clients. Mark
-- them revoked, then deterministically collapse any historical create-race
-- duplicates before installing the invariant that prevents new ones. Keep the
-- earliest still-live invitation because that is the one login bootstrap has always
-- selected (`order by created_at`).
update household_invites
   set revoked_at = clock_timestamp()
 where accepted_at is null
   and revoked_at is null
   and access_expires_at is not null
   and access_expires_at <= clock_timestamp();

with ranked_pending_invites as (
  select id,
         row_number() over (
           partition by household_id, lower(email)
           order by created_at, id
         ) as duplicate_number
    from household_invites
   where accepted_at is null
     and revoked_at is null
)
update household_invites hi
   set revoked_at = clock_timestamp()
  from ranked_pending_invites ranked
 where hi.id = ranked.id
   and ranked.duplicate_number > 1;

create unique index uq_household_invites_pending_email
  on household_invites (household_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- Serialize a membership/invite write with timezone changes by taking a SHARE
-- row lock on its household. A concurrent timezone UPDATE must either finish
-- first (and this trigger sees the new zone) or wait until this write commits,
-- after which its refresh trigger recalculates this row.
create function canonicalize_household_access_window()
returns trigger
language plpgsql
as $$
declare
  household_timezone text;
begin
  select h.timezone
    into household_timezone
    from households h
   where h.id = new.household_id
   for share;

  if not found then
    raise exception 'household % does not exist', new.household_id
      using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'INSERT' then
    -- No canonical date means a legacy caller supplied only the exact instant.
    if new.access_ends_on is null and new.access_expires_at is not null then
      new.access_ends_on := case
        when (new.access_expires_at at time zone household_timezone)::time >= time '23:59:59'
          then (new.access_expires_at at time zone household_timezone)::date
        else (new.access_expires_at at time zone household_timezone)::date - 1
      end;
    end if;
  elsif new.access_ends_on is distinct from old.access_ends_on then
    -- The canonical field wins when explicitly changed, including a null clear.
    null;
  elsif new.access_expires_at is distinct from old.access_expires_at then
    -- Rolling-upgrade compatibility: canonicalize a legacy exact-instant patch.
    if new.access_expires_at is null then
      new.access_ends_on := null;
    else
      new.access_ends_on := case
        when (new.access_expires_at at time zone household_timezone)::time >= time '23:59:59'
          then (new.access_expires_at at time zone household_timezone)::date
        else (new.access_expires_at at time zone household_timezone)::date - 1
      end;
    end if;
  end if;

  if new.access_ends_on is null then
    new.access_expires_at := null;
  else
    new.access_expires_at := ((new.access_ends_on + 1)::timestamp at time zone household_timezone);
  end if;

  return new;
end $$;

create trigger trg_person_access_window_insert
before insert on persons
for each row
execute function canonicalize_household_access_window();

create trigger trg_person_access_window_update
before update of household_id, access_ends_on, access_expires_at on persons
for each row
execute function canonicalize_household_access_window();

create trigger trg_invite_access_window_insert
before insert on household_invites
for each row
execute function canonicalize_household_access_window();

create trigger trg_invite_access_window_update
before update of household_id, access_ends_on, access_expires_at on household_invites
for each row
execute function canonicalize_household_access_window();

create function refresh_household_access_windows()
returns trigger
language plpgsql
as $$
begin
  -- Assigning the canonical field to itself invokes the child trigger, which is
  -- the single implementation of date -> instant conversion and sees NEW.timezone
  -- inside this transaction.
  update persons
     set access_ends_on = access_ends_on
   where household_id = new.id
     and access_ends_on is not null;

  update household_invites
     set access_ends_on = access_ends_on
   where household_id = new.id
     and access_ends_on is not null;

  return new;
end $$;

create trigger trg_household_access_windows
after update of timezone on households
for each row
when (old.timezone is distinct from new.timezone)
execute function refresh_household_access_windows();

-- Down Migration

drop index if exists uq_household_invites_pending_email;

drop trigger if exists trg_household_access_windows on households;
drop function if exists refresh_household_access_windows();

drop trigger if exists trg_invite_access_window_update on household_invites;
drop trigger if exists trg_invite_access_window_insert on household_invites;
drop trigger if exists trg_person_access_window_update on persons;
drop trigger if exists trg_person_access_window_insert on persons;
drop function if exists canonicalize_household_access_window();

alter table household_invites
  drop constraint if exists chk_invite_access_end_role,
  drop constraint if exists chk_invite_access_window_pair,
  drop column if exists access_ends_on;

alter table persons
  drop constraint if exists chk_person_access_end_role,
  drop constraint if exists chk_person_access_window_pair,
  drop column if exists access_ends_on;
