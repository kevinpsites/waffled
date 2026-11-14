-- Up Migration
-- One row per MCP tools/call of a WRITE tool, including refusals, so an agent's changes
-- are attributable without a `source` column on every domain table. The caller is an API
-- key today; `grant_id` will name an OAuth grant once connector sign-in lands (no FK yet,
-- that table doesn't exist). `target_ids` holds ids only, never argument text.
create table mcp_audit (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  person_id    uuid not null,
  api_key_id   uuid references api_keys(id) on delete set null,
  grant_id     uuid,
  tool         text not null,
  target_ids   jsonb not null default '{}'::jsonb,
  outcome      text not null check (outcome in ('ok', 'error', 'denied')),
  error        text,
  created_at   timestamptz not null default now(),
  -- Composite, like every persons reference since 0104.
  foreign key (household_id, person_id) references persons (household_id, id)
);
create index ix_mcp_audit_household on mcp_audit (household_id, created_at desc);

-- Down Migration
drop table if exists mcp_audit cascade;
