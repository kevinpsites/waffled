-- Up Migration
-- The four clear participant "types" a count/total goal can use collapse two ideas that
-- used to be separate controls (tracking_mode + participant_mode) into one choice:
--   #1 Everyone individually — each_tracks + target_basis 'per_person' (read 12 EACH;
--      ring target = target_value × member count, so it auto-grows when someone joins).
--   #2 We all chip in       — each_tracks + target_basis 'family' (one shared 12; every
--      person's contribution stacks toward it). Counting is identical to #1; only the
--      target basis (the ring's denominator) differs.
--   #3 Shared & split       — shared_total + participant_mode 'split' (a group entry is
--      divided evenly across who took part).
--   #4 Count once           — shared_total + participant_mode 'count_once' (one entry =
--      +amount no matter who; the people are attendance).
--
-- target_basis is the ONLY new bit of state: it tells #1 apart from #2 (both each_tracks).
-- Additive, defaults to 'family' so every existing goal is unchanged.
alter table goals add column target_basis text not null default 'family';

-- Retire the confusing 'credit_each' mode (family counts once, yet each person got full
-- personal credit — numbers that never added up, which is exactly what confused users).
-- Land any existing credit_each goals on the closest surviving behaviour: 'split'.
update goals set participant_mode = 'split' where participant_mode = 'credit_each';

-- Down Migration
alter table goals drop column if exists target_basis;
