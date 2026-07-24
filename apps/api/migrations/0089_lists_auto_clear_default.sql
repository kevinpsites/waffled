-- Up Migration
-- Make auto-clear ON by default (24h) for lists WITHOUT breaking the column's
-- documented `null = never` sentinel (migrations/0004_lists.sql). Previously the
-- sweep coalesced null→24h, which meant every existing list auto-cleared AND there
-- was no value left that meant "never". Instead, give the column a real default and
-- backfill existing custom lists, so `null` can keep meaning "never" for a future
-- per-list setting. The sweep is scoped to list_type='custom', so grocery/templates
-- are unaffected regardless of their value.
alter table lists alter column auto_clear_checked set default interval '24 hours';
update lists set auto_clear_checked = interval '24 hours'
  where auto_clear_checked is null and list_type = 'custom';

-- Down Migration
alter table lists alter column auto_clear_checked drop default;
