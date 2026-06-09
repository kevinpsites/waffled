-- Up Migration
-- Per-step ingredients (the markdown lists the ingredients used at each step —
-- required to keep). Stored on the step as a small jsonb array of display lines.

alter table recipe_steps add column ingredients jsonb not null default '[]';

-- Down Migration

alter table recipe_steps drop column if exists ingredients;
