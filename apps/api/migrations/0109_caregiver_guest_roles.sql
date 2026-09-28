-- Up Migration
-- Temporary household access belongs to the membership, not the login account.
-- A caregiver/guest can therefore expire in one household without affecting the
-- same account's other household memberships.

-- Do not guess what an installation's custom roles mean. Earlier schemas did not
-- constrain member_type, so an operator may have values we cannot safely map to a
-- built-in role. Abort before changing the schema or data and name every unknown
-- value so the operator can make that policy decision explicitly.
do $$
declare
  unknown_person_roles text[];
  unknown_invite_roles text[];
begin
  select array_agg(role order by role)
    into unknown_person_roles
    from (
      select distinct coalesce(member_type, '<null>') as role
        from persons
       where member_type is null
          or member_type not in ('adult', 'caregiver', 'guest', 'teen', 'kid')
    ) unknown_person_values;

  select array_agg(role order by role)
    into unknown_invite_roles
    from (
      select distinct coalesce(member_type, '<null>') as role
        from household_invites
       where member_type is null
          or member_type not in ('adult', 'caregiver', 'guest', 'teen', 'kid')
    ) unknown_invite_values;

  if unknown_person_roles is not null or unknown_invite_roles is not null then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'Cannot add caregiver/guest constraints: unknown member_type values (persons: %s; household_invites: %s). Rename these roles explicitly, then retry.',
        coalesce(array_to_string(unknown_person_roles, ', '), 'none'),
        coalesce(array_to_string(unknown_invite_roles, ', '), 'none')
      );
  end if;
end $$;

alter table persons
  add column access_expires_at timestamptz;

alter table household_invites
  add column access_expires_at timestamptz;

-- Earlier schemas did not tie admin status to a role. The meaning of this invalid
-- combination is unambiguous: preserve admin access and normalize the known role
-- to adult before installing the constraint.
update persons
   set member_type = 'adult'
 where is_admin
   and member_type in ('caregiver', 'guest', 'teen', 'kid');

update household_invites
   set member_type = 'adult'
 where is_admin
   and member_type in ('caregiver', 'guest', 'teen', 'kid');

-- Be defensive if an operator tested a pre-release version of this migration:
-- permanent roles must never retain a temporary-access deadline.
update persons
   set access_expires_at = null
 where access_expires_at is not null
   and member_type not in ('caregiver', 'guest');

update household_invites
   set access_expires_at = null
 where access_expires_at is not null
   and member_type not in ('caregiver', 'guest');

alter table persons
  add constraint chk_person_member_type
  check (member_type in ('adult', 'caregiver', 'guest', 'teen', 'kid')),
  add constraint chk_person_admin_role
  check (not is_admin or member_type = 'adult'),
  add constraint chk_person_access_expiry_role
  check (access_expires_at is null or member_type in ('caregiver', 'guest'));

alter table household_invites
  add constraint chk_invite_member_type
  check (member_type in ('adult', 'caregiver', 'guest', 'teen', 'kid')),
  add constraint chk_invite_admin_role
  check (not is_admin or member_type = 'adult'),
  add constraint chk_invite_access_expiry_role
  check (access_expires_at is null or member_type in ('caregiver', 'guest'));

create index ix_persons_account_active_access
  on persons (account_id, household_id, access_expires_at)
  where account_id is not null and deleted_at is null;

-- Down Migration

drop index if exists ix_persons_account_active_access;

alter table household_invites
  drop constraint if exists chk_invite_access_expiry_role,
  drop constraint if exists chk_invite_admin_role,
  drop constraint if exists chk_invite_member_type,
  drop column if exists access_expires_at;

alter table persons
  drop constraint if exists chk_person_access_expiry_role,
  drop constraint if exists chk_person_admin_role,
  drop constraint if exists chk_person_member_type,
  drop column if exists access_expires_at;
