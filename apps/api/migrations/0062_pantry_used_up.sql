-- Up Migration
-- Pantry items get a "used up" state distinct from removal: when you finish the
-- last of something it's greyed out (still listed) so you can push it to the
-- shopping list or remove it, rather than silently vanishing. deleted_at remains
-- the hard removal; used_up_at is the soft, recoverable "ran out" marker.

alter table pantry_items add column used_up_at timestamptz;

-- Down Migration

alter table pantry_items drop column if exists used_up_at;
