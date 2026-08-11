-- Up Migration
-- Calendar provider abstraction: calendar accounts can now be Google OR
-- Microsoft (Outlook / Graph). Additive by design — the google_* columns keep
-- their names but mean "provider external id" (google_sub = OAuth subject,
-- google_calendar_id = provider calendar id, events.google_event_id = provider
-- event id, calendars.sync_token = Google syncToken or Graph @odata.deltaLink).
-- Renaming them would churn every query for no gain.
--
-- Written idempotently (`if not exists`) so a downstream fork that already
-- carries an equivalent migration under a different number can merge this
-- without the column adds failing on a second apply.

alter table calendar_accounts add column if not exists provider text not null default 'google';
alter table calendars add column if not exists provider text not null default 'google';
alter table calendar_oauth_states add column if not exists provider text not null default 'google';

-- One account row per (household, provider, subject) — subjects from different
-- providers may collide in theory, and the provider now disambiguates.
alter table calendar_accounts drop constraint if exists calendar_accounts_household_id_google_sub_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calendar_accounts_household_provider_sub_key'
  ) then
    alter table calendar_accounts add constraint calendar_accounts_household_provider_sub_key
      unique (household_id, provider, google_sub);
  end if;
end $$;

-- Down Migration
alter table calendar_accounts drop constraint if exists calendar_accounts_household_provider_sub_key;
alter table calendar_accounts add constraint calendar_accounts_household_id_google_sub_key
  unique (household_id, google_sub);
alter table calendar_accounts drop column if exists provider;
alter table calendars drop column if exists provider;
alter table calendar_oauth_states drop column if exists provider;
