-- Per-reward parent-approval flag, mirroring chores.requires_approval. Default true so
-- existing rewards keep the approval gate; the household default applied to NEW rewards
-- lives in households.settings.rewards.requireApproval (set in Settings → Chores & rewards).
alter table rewards add column if not exists requires_approval boolean not null default true;
