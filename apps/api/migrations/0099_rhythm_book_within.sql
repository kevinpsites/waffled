-- Up Migration
-- A booking window narrower than the period (docs/product/rhythms-plan.md).
--
-- 0098 gave `every` two jobs: how often the thing should happen, AND how wide the span is
-- that a booking may land in. For most rhythms those are the same span — a quarterly
-- temple visit can go anywhere in the quarter. For "date night, in the first week of the
-- month" they are not, and there was no way to say so.
--
-- The runway is the only phase control there was, and it is measured back from the
-- period's END and clamped to `every/2`, so:
--   * a monthly rhythm cannot be asked about before mid-month;
--   * a quarterly one cannot be asked about before mid-quarter — "in the first two weeks
--     of the quarter" had no expressible form at all, not merely an awkward one.
-- Relaxing that clamp is not the fix: a runway as long as the cycle never closes, so the
-- rhythm would never go quiet, which is the thing the clamp exists to guarantee.
--
-- So the two jobs are split. `every` keeps the grid: period N is still
-- [starts_on + N*every, starts_on + (N+1)*every), it still owns rhythm_skips' keys, and it
-- still says how often. `book_within` says how much of the period a booking counts in,
-- measured from the period's start. Null means the whole period — which is exactly what
-- every rhythm written before this column had, so nothing about them changes.
--
-- Head-anchored deliberately, with no separate offset: `starts_on` already phases the
-- grid, so "the LAST week of the month" is an anchor on the 25th with a 7-day window. A
-- second knob would only be a second way to say the same thing, and two ways to phase one
-- window is how they come to disagree.
alter table rhythms add column book_within interval;

-- Kept as a separate constraint rather than folded into rhythms_shape_is_coherent, so a
-- violation names which rule was broken instead of pointing at the whole shape.
--
-- Three clauses, each closing a hole the period math cannot recover from:
--
--   * completion has no periods at all — its clock restarts from when you did the thing —
--     so a window has nothing to sit inside.
--   * a non-positive window can never contain a booking, so every period would be
--     permanently unsatisfiable. (That it must also not EXCEED `every` is checked in the
--     writer, where a short-month probe can be used: interval comparison normalises a
--     month to 30 days, so '30 days' <= '1 mon' passes here and then overruns February.)
--   * auto_schedule and a window are answers to the same question — "when inside the
--     period does this happen?" — and the rule wins, because it is what actually creates
--     the event. Allowed together, a rule may generate its occurrence outside the window
--     and EVERY period becomes unsatisfiable while the series sits on the calendar in
--     plain sight: the same failure 0098's anchor guard exists to prevent, arriving
--     through a different door.
alter table rhythms add constraint rhythms_window_is_coherent check (
  book_within is null
  or (satisfied_by = 'scheduling' and book_within > interval '0' and auto_schedule = false)
);

-- Down Migration
alter table rhythms drop constraint if exists rhythms_window_is_coherent;
alter table rhythms drop column if exists book_within;
