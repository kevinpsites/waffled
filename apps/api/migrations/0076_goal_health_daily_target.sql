-- Up Migration
-- Health-linked HABIT goals need a daily threshold: "2,000 steps a day, 5 days a week".
-- On each synced day, the metric total counts as ONE habit completion when it clears this
-- number (the habit's per-day dedupe still makes it at most one/day). Null for non-habit
-- or non-health goals, which accumulate the raw total toward target_value instead.
alter table goals add column health_daily_target numeric;

-- Down Migration
alter table goals drop column if exists health_daily_target;
