-- Up Migration
-- A completion rhythm can sit on a FIXED grid instead of restarting its clock when you
-- tap it. "Clean the floors in the 1st and 3rd week of the month" is the case: marking it
-- off is the whole outcome (so it is completion-shaped), but the schedule must not drift
-- the way `last_completed_at + every` does — do it late and the next one has to stay put.
--
-- The grid is days of the month, one period running until the next day in the list, so a
-- month is partitioned: exactly one slot is ever open, missing one lets it nag until the
-- next opens, and then it is simply gone. {1,15} is "1st week" and "3rd week".
--
-- Opt-in and nullable: every existing rhythm keeps `starts_on + n × every` untouched, and
-- `satisfied_by` is deliberately NOT given a third value, so no client has to learn a new
-- shape to keep rendering these (an older app reads an ordinary completion rhythm).
alter table rhythms add column grid_days smallint[];

-- Stops at 28 for the reason the monthly day picker stops at a fourth weekday: a 29th to
-- 31st is missing from some months, so that slot would vanish and the one before it would
-- silently stretch. A constant array, not a subquery — CHECK cannot contain one.
alter table rhythms add constraint rhythms_grid_days_are_days_of_a_month check (
  grid_days is null
  or (satisfied_by = 'completion'
      and array_length(grid_days, 1) between 1 and 28
      and grid_days <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28}'::smallint[])
);

-- Which period a check-off closed. Null on every row that predates the grid, and on any
-- completion of a rhythm that has none — those are still "when did we last do it?".
-- Unique per period so a second tap in the same slot folds instead of stacking, the same
-- per-period key rhythm_skips already uses.
alter table rhythm_completions add column period_start date;
create unique index ux_rhythm_completions_period
  on rhythm_completions (rhythm_id, period_start) where period_start is not null;

-- The shape check predates the grid and forbids a completion rhythm any anchor at all.
-- grid_days is that anchor for this one case, so the rule becomes "no starts_on / rrule /
-- auto_schedule", which is what it was really protecting: the period math it cannot do.
alter table rhythms drop constraint rhythms_shape_is_coherent;
alter table rhythms add constraint rhythms_shape_is_coherent check (
  (satisfied_by = 'completion'
     and next_due_at is not null
     and starts_on is null
     and rrule is null and auto_schedule = false)
  or
  (satisfied_by = 'scheduling'
     and starts_on is not null
     and next_due_at is null and last_completed_at is null
     and grid_days is null
     and (auto_schedule = false or rrule is not null))
);

-- Down Migration
alter table rhythms drop constraint if exists rhythms_shape_is_coherent;
alter table rhythms add constraint rhythms_shape_is_coherent check (
  (satisfied_by = 'completion'
     and next_due_at is not null
     and starts_on is null
     and rrule is null and auto_schedule = false)
  or
  (satisfied_by = 'scheduling'
     and starts_on is not null
     and next_due_at is null and last_completed_at is null
     and (auto_schedule = false or rrule is not null))
);
drop index if exists ux_rhythm_completions_period;
alter table rhythm_completions drop column if exists period_start;
alter table rhythms drop constraint if exists rhythms_grid_days_are_days_of_a_month;
alter table rhythms drop column if exists grid_days;
