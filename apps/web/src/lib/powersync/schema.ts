// PowerSync client schema — the local SQLite mirror of the tables we replicate
// (see infra/compose/powersync/sync-config.yaml). PowerSync downloads only tables
// declared here; `id` is an implicit text primary key, so it's never listed.
// Columns are stored loosely (text / integer); this is the foundation other
// screens can read from directly later. Today we use it to drive realtime refresh.
import { column, Schema, Table } from '@powersync/web'

const events = new Table({
  household_id: column.text,
  calendar_id: column.text,
  title: column.text,
  description: column.text,
  location: column.text,
  starts_at: column.text,
  ends_at: column.text,
  all_day: column.integer,
  timezone: column.text,
  status: column.text,
  person_id: column.text,
  origin: column.text,
  updated_at: column.text,
})

const event_participants = new Table({
  household_id: column.text,
  event_id: column.text,
  person_id: column.text,
})

const persons = new Table({
  household_id: column.text,
  name: column.text,
  color_hex: column.text,
  avatar_emoji: column.text,
  member_type: column.text,
  sort_order: column.integer,
  created_at: column.text,
})

const households = new Table({
  name: column.text,
  timezone: column.text,
  week_start: column.text,
})

export const AppSchema = new Schema({ events, event_participants, persons, households })
