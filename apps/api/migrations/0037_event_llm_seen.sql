-- Up Migration
-- Phase B performance: the suggestions endpoint falls back to an LLM for events
-- the keyword/memory matcher can't place. Without a marker it would re-ask the LLM
-- about the SAME unmatchable events ("Dentist", "Arabic Lesson") on every single
-- load — slow and wasteful. This records that an event has already been through the
-- LLM (match or not), so each event is classified at most once. LLM *matches* land
-- in goal_match_memory; this just stops the re-asking. REST-only, not synced.
create table event_llm_seen (
  event_id     uuid primary key references events(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index ix_event_llm_seen_hh on event_llm_seen (household_id);

-- Down Migration
drop table if exists event_llm_seen cascade;
