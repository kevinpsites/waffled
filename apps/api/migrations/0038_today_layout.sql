-- Today dashboard card layout. Two tiers: a family default on the household and
-- an optional per-person override. Resolution at render is user ?? family ??
-- built-in default. Stored as jsonb: an array of columns, each an array of card
-- keys, e.g. [["agenda"],["tonight","week"],["chores","grocery"]].
alter table households add column if not exists today_layout jsonb;
alter table persons    add column if not exists today_layout jsonb;
