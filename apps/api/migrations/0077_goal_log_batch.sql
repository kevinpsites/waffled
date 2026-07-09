-- Up Migration
-- Splitting a shared divisible pool (shared_total + total) across several people writes
-- one goal_logs row PER PERSON (2h together → 1h Kevin + 1h Kelly). Those rows are the
-- source of truth for per-person progress, but the audit log showed them as two verbose
-- lines with the same date and halved amounts. batch_id links the siblings from a single
-- log action so the read side can collapse them back into one entry (summed amount +
-- participant avatars). Only the split path sets it; every other log stays null and keeps
-- rendering as its own row exactly as before.
alter table goal_logs add column batch_id uuid;

-- Group the split siblings efficiently when building a goal's recent activity.
create index if not exists ix_goal_logs_batch on goal_logs (goal_id, batch_id) where deleted_at is null;

-- Down Migration
drop index if exists ix_goal_logs_batch;
alter table goal_logs drop column if exists batch_id;
