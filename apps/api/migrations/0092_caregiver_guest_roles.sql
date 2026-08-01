-- Up Migration
-- Temporary household access belongs to the membership, not the login account.
-- A caregiver/guest can therefore expire in one household without affecting the
-- same account's other household memberships.

alter table persons
  add column access_expires_at timestamptz;

alter table household_invites
  add column access_expires_at timestamptz;

-- Earlier schemas accepted arbitrary member_type values and did not tie admin
-- status to a role. Normalize those legacy rows before installing the checks so
-- an upgrade cannot stop halfway through. Unknown non-admin roles become the
-- least-privileged guest role; admins remain admins but are normalized to adult.
update persons
   set member_type = case when is_admin then 'adult' else 'guest' end
 where member_type not in ('adult', 'caregiver', 'guest', 'teen', 'kid')
    or (is_admin and member_type <> 'adult');

update household_invites
   set member_type = case when is_admin then 'adult' else 'guest' end
 where member_type not in ('adult', 'caregiver', 'guest', 'teen', 'kid')
    or (is_admin and member_type <> 'adult');

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
