-- Up Migration
-- "Auto-count from calendar" becomes an independent capability rather than one of
-- the mutually-exclusive log methods: a goal can be logged manually AND have
-- matching calendar events auto-count toward it. (The event→goal wiring lands
-- later; this stores the per-goal opt-in.) The old enter-amount-vs-one-tap fork
-- is retired — logging style is derived from goal_type now, so log_method keeps
-- its 'quick_log' default for back-compat but is no longer a user choice.
alter table goals add column auto_from_calendar boolean not null default false;

-- Down Migration
alter table goals drop column if exists auto_from_calendar;
