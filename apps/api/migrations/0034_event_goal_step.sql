-- Up Migration
-- Checklist goals can now be scheduled too. A calendar event already carries a
-- goal_id (0033); for a checklist goal that isn't enough — "did this happen?" must
-- know WHICH step the event was meant to complete. So an event can also point at a
-- specific goal_step, and confirming the recap ticks that step (instead of adding a
-- numeric amount the way total/count/habit goals do).
alter table events add column goal_step_id uuid references goal_steps(id) on delete set null;

-- Record which step a confirmed checklist recap ticked (provenance, mirrors
-- goal_log_id for amount-based goals). Null for non-checklist resolutions.
alter table event_goal_logs add column goal_step_id uuid references goal_steps(id) on delete set null;

-- Down Migration
alter table event_goal_logs drop column if exists goal_step_id;
alter table events drop column if exists goal_step_id;
