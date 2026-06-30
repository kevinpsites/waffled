-- Up Migration
-- "May contain" (traces) allergens from Open Food Facts (traces_tags), distinct from
-- definite allergens. Surfaced as a lighter warning — matters for cross-contamination
-- (e.g. a gluten-free household). Cached on products + snapshotted on items.

alter table products add column traces text[] not null default '{}';
alter table pantry_items add column traces text[];

-- Down Migration

alter table products drop column if exists traces;
alter table pantry_items drop column if exists traces;
