// Weekly Planning · step 5 (Connection) — this step's API client and its types.
//
// TWO READS, NO WRITE. A pairing's status is a query over event_participants, and claiming
// a slot writes an ORDINARY CALENDAR EVENT through the app's own `EventModal`, which owns
// the local-first path. A `create pairing` call here would be a second door onto events.
import { apiGet, apiSend } from '../client'

export interface PlanningConnectionSlot {
  date: string
  /**
   * When the gap opens, or null for a day with nothing on it. NULL IS NOT "unknown": the
   * whole day is free, and the event modal's time picker decides — the step never names
   * an hour the week doesn't justify.
   */
  startsAt: string | null
  kind: 'after' | 'open'
  afterTitle: string | null
  /** "Wed after Scouts" / "Tue after 8:30 PM" / "Sun · free all day". Built server-side so iOS says it the same way. */
  label: string
}

export interface PlanningConnectionEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  minutes: number | null
  day: string
  time: string | null
  /** "Saturday 1:00 PM" — formatted in the household's zone, server-side. */
  when: string
}

export interface PlanningConnectionPairing {
  personIds: string[]
  who: string
  lastTogetherOn: string | null
  lastTogetherTitle: string | null
  alreadyThisWeek: PlanningConnectionEvent[]
  togetherThisWeek: PlanningConnectionEvent[]
  /** Ranked gaps, roomiest first — ALL of them. How many chips fit is this step's call. */
  slots: PlanningConnectionSlot[]
}

export interface PlanningConnectionBoard {
  /** The week the server resolved (snapped and floored) — echoed, never computed here. */
  weekStart: string
  pairings: PlanningConnectionPairing[]
}

export interface PlanningConnectionSlots {
  weekStart: string
  personIds: string[]
  who: string
  slots: PlanningConnectionSlot[]
}

export const planningConnectionApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningConnectionBoard>(`/api/weekly-planning/connection${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // The same gaps for people the app didn't suggest — what makes "Make a pairing" a
  // first-class action instead of a blank date picker.
  slotsFor: (weekStart: string, personIds: string[]) =>
    apiGet<PlanningConnectionSlots>(
      `/api/weekly-planning/connection/slots?weekStart=${weekStart}&people=${personIds.join(',')}`
    ),

  // WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people. It stores a POINTER,
  // because a link is the answer to a pairing and has to outlive the render that made it.
  // A MID-STEP write: it merges onto the step's row and deliberately does not settle the
  // step (not `decideStep`, which would restamp `decided_at`).
  saveLinks: (sessionId: string, links: Record<string, string>) =>
    apiSend<{ ok: true }>('PUT', '/api/weekly-planning/connection/links', { sessionId, links }),
}
