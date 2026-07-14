-- Up Migration
-- Participant counting for SHARED goals. When one log involves several people, what
-- should it mean? Three modes, chosen per goal (shared_total only; each_tracks keeps
-- its own "each person full, collective sum" behavior):
--   • count_once   — one shared event (a park visit, a camping trip). The goal gains
--                    the amount ONCE; the people tapped are recorded as ATTENDANCE
--                    (who was there), not a multiplier.
--   • credit_each  — everyone tapped gets the FULL amount toward their own tally (the
--                    hours leaderboard: "who spent the most time"), while the family
--                    goal still gains the amount once.
--   • split        — the amount is divided evenly across the people tapped (today's
--                    behavior for a shared divisible pool like hours).
--
-- The mechanism is a per-row `counts_total` flag: the FAMILY total sums only rows where
-- counts_total is true, while the per-person leaderboard sums every row by person. That
-- lets credit_each write a single family row (the amount, counts_total) PLUS per-person
-- attribution rows (the amount each, NOT counted toward the family total) without the
-- family number multiplying. count_once does the same with amount-0 attendance rows.
-- split (and each_tracks, and every legacy row) writes per-person rows that DO count.
alter table goals add column participant_mode text not null default 'count_once';

alter table goal_logs add column counts_total boolean not null default true;

-- Preserve existing behavior: a shared divisible pool (hours etc.) was split before this
-- feature existed, so keep those goals on 'split'. Everything else takes the safe default
-- ('count_once' — never inflates the family number). each_tracks goals ignore the mode.
update goals set participant_mode = 'split'
 where tracking_mode = 'shared_total' and goal_type = 'total';

-- Down Migration
alter table goal_logs drop column if exists counts_total;
alter table goals drop column if exists participant_mode;
