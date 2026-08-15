// Per-person calendar columns — the bucketing behind the "People" view.
//
// An event lands in its OWNER's column and in every participant's column, so a
// shared event reads from each person's lane instead of hiding under one name.
// "Owner" is `events.person_id` (the assignee that drives the event's color) —
// NOT `owner_person_id`, which migration 0074 added for personal-calendar
// visibility and says nothing about whose day this belongs to.
//
// Bucketing is COLUMN-driven (ask each person "is this yours?") rather than
// event-driven (collect columns from an event's participants). Migration 0009
// allows participant rows for people outside the household (`person_id` null with
// an `external_email`), and column-driven bucketing ignores those for free
// instead of inventing a phantom column for Newman.
import type { AgendaEvent } from '../../lib/api'
import { packLanes } from './cal-utils'

// The household people the columns are drawn for.
export interface ColumnPerson {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

// The id of the leading catch-all column. Only present when something actually
// needs it — an event with no household owner and no household participant.
// Underscore-prefixed so it can never collide with a person's uuid.
export const UNASSIGNED_COLUMN = '_everyone'

export interface PeopleColumn extends ColumnPerson {
  events: AgendaEvent[]
  // Lane packing is computed PER COLUMN. Packing once across all columns would
  // squeeze an event that overlaps something in a different person's lane, so a
  // shared event would render as a sliver in columns where it's the only thing.
  lanes: Map<string, { lane: number; lanes: number }>
}

// Does this event belong in `personId`'s column?
function belongsTo(e: AgendaEvent, personId: string): boolean {
  return e.personId === personId || (e.participants ?? []).some((p) => p.id === personId)
}

export function peopleColumns(events: AgendaEvent[], people: ColumnPerson[]): PeopleColumn[] {
  const build = (p: ColumnPerson, evs: AgendaEvent[]): PeopleColumn => ({
    ...p,
    events: evs,
    lanes: packLanes(evs.filter((e) => !e.allDay)),
  })

  const columns = people.map((p) => build(p, events.filter((e) => belongsTo(e, p.id))))

  // Anything no column claimed — an event with nobody on it, or one whose only
  // people have left the household. It must not silently vanish from the view.
  const claimed = new Set(columns.flatMap((c) => c.events.map((e) => e.id)))
  const orphans = events.filter((e) => !claimed.has(e.id))
  if (orphans.length === 0) return columns

  const everyone = build(
    { id: UNASSIGNED_COLUMN, name: 'Everyone', colorHex: null, avatarEmoji: null },
    orphans
  )
  return [everyone, ...columns]
}
