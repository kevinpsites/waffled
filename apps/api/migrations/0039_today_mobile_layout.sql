-- Mobile Today card layout. Same two-tier model as today_layout (a family
-- default on the household + an optional per-person override, resolved as
-- user ?? family ?? built-in), but a mobile-specific shape: the phone stacks
-- cards in a single column and can hide them, so it's stored as
-- jsonb { "order": ["agenda", ...], "hidden": ["chores", ...] } rather than the
-- kiosk's 3-column grid. Kept separate because the card sets differ too
-- (mobile has "goals", no "week").
alter table households add column if not exists today_mobile_layout jsonb;
alter table persons    add column if not exists today_mobile_layout jsonb;
