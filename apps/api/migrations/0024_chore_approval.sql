-- Up Migration
-- Optional parent-approval gate on a chore. When set, completing an instance
-- parks it in 'awaiting' (no stars yet); a parent approves → 'done' + award, or
-- rejects → back to 'pending'. Snapshotted onto the instance at materialization
-- so changing the chore later doesn't retroactively alter in-flight instances.

alter table chores add column if not exists requires_approval boolean not null default false;
alter table chore_instances add column if not exists requires_approval boolean not null default false;

-- Down Migration

alter table chore_instances drop column if exists requires_approval;
alter table chores drop column if exists requires_approval;
