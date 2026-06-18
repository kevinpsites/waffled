-- Up Migration
-- A kid can pin one reward from the (parent-curated) shop as what they're
-- "saving toward" — the Stars-bank / Goal-jar progress bar reads against it.
-- Just a per-person pointer into the rewards catalog; cleared if that reward is
-- deleted. The same earning ledger powers it; nothing else changes.
alter table persons add column saving_toward_reward_id uuid references rewards(id) on delete set null;

-- Down Migration
alter table persons drop column if exists saving_toward_reward_id;
