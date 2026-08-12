-- Up Migration
-- A free-text store/vendor per grocery item (Costco, Walmart, …) so the shopper can
-- assign items to where they'll buy them and group/sort the list by store. Nullable;
-- unset means "no store". Reuse of prior values (the quick-select) is derived from the
-- distinct non-null values in use, so "Costco" and "costco" collapse to whatever the
-- household already typed.
alter table list_items add column store text;

-- Down Migration
alter table list_items drop column store;
