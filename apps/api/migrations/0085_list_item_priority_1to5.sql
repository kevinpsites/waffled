-- Up Migration
-- Widen list-item priority from a 3-level scale (0/1/2) to a 1–5 urgency scale:
--   1 = not urgent, 3 = normal (the new default), 5 = urgent.
-- Higher still sorts first. Remap existing rows so nothing loses its relative
-- standing: old normal(0)→3, old important(1)→4, old urgent(2)→5. Anything else
-- lands on normal(3). Then make 3 the default and constrain the column to 1..5.

update list_items set priority = case priority
    when 0 then 3
    when 1 then 4
    when 2 then 5
    else 3 end;

alter table list_items alter column priority set default 3;
alter table list_items add constraint list_items_priority_range check (priority between 1 and 5);

-- Down Migration

alter table list_items drop constraint if exists list_items_priority_range;
alter table list_items alter column priority set default 0;
update list_items set priority = case priority
    when 3 then 0
    when 4 then 1
    when 5 then 2
    else 0 end;
