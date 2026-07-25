-- Up Migration
-- List items gain a priority so the family can flag what matters:
--   0 = normal, 1 = important, 2 = urgent.
-- Higher priority sorts first (a tie-breaker layered into the existing item order,
-- ahead of manual sort_order). The default keeps every existing item at "normal".

alter table list_items
  add column priority smallint not null default 0;

-- Down Migration

alter table list_items drop column if exists priority;
