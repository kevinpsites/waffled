-- Up Migration
-- Per-step timers for Cook mode: a step can carry an optional countdown duration.
-- Stored as a single nullable integer of TOTAL seconds (minutes + optional seconds
-- collapsed at the editor); null = no timer. The cook starts it from the step and it
-- runs in a floating dock independent of which step is on screen.

alter table recipe_steps add column timer_seconds int;

-- Down Migration

alter table recipe_steps drop column if exists timer_seconds;
