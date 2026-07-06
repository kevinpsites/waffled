-- Up Migration
-- Reusable list templates (Option A — lightest approach). A template is just a
-- `lists` row with list_type='template' whose list_items are stored checked=false;
-- there is no separate table. Saving a list as a template copies its live items
-- (unchecked); applying a template spins up a fresh list_type='custom' list with
-- everything unchecked. `source_template_id` records which template a list was
-- spun up from (provenance; nullable — most lists have no template origin).

alter table lists add column source_template_id uuid references lists(id);

-- Down Migration

alter table lists drop column if exists source_template_id;
