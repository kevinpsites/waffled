// Step 4 · Family night — this step's API client and its types.
//
// ONE read, and NO write of its own: pinning a face, naming the theme and calling the week off are
// all `familyNightApi.saveOccurrence`, and a parallel write path here would be a second place for
// "who's on the treat" to be true. A pin is scoped to the DATE, and materializing the occurrence
// is also what shifts next week's turn.
import { apiGet } from '../client'
import { emit } from '../bus'
import { familyNightApi } from '../familyNight'

export interface PlanningFamilyNightMember {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
}

export interface PlanningFamilyNightPart {
  partId: string
  label: string
  emoji: string
  // False ⇒ the rotation never auto-fills this part. It still takes a pin.
  rotates: boolean
  /** What this part IS this week — a different question from whose turn it is. Writing one does
   *  NOT pin the person. */
  detail: string | null
  personId: string | null
  personName: string | null
  // True ⇒ somebody chose this, for this week. False ⇒ the rotation's suggestion, written nowhere.
  pinned: boolean
}

export interface PlanningFamilyNightBoard {
  // The week the server resolved — echoed, never recomputed here.
  weekStart: string
  date: string // the gathering's date inside that week
  dayOfWeek: number
  time: string // 'HH:MM' local
  occurrenceId: string | null
  theme: string | null
  status: 'planned' | 'done' | 'skipped'
  // A recurring calendar event behind this. Only then may the step promise a skip leaves it alone.
  onCalendar: boolean
  /** THIS week's own calendar event, separate from `onCalendar`'s standing series. */
  eventId: string | null
  eventTitle: string | null
  eventWhen: string | null
  members: PlanningFamilyNightMember[]
  parts: PlanningFamilyNightPart[]
}

  // Every write re-emits `weeklyPlanning` too, so the session view refetches with the Today card.
const alsoPlanning = <T,>(p: Promise<T>): Promise<T> => p.then((r) => { emit('weeklyPlanning'); return r })

export const planningFamilyNightApi = {
  // `weekStart` is the one the session view handed us — passed back, never computed.
  board: (weekStart?: string) =>
    apiGet<PlanningFamilyNightBoard>(`/api/weekly-planning/familyNight${weekStart ? `?weekStart=${weekStart}` : ''}`),

  // Tap a face. `personId: null` clears the part — that still WRITES an assignment row, so the
  // part reads "nobody yet" rather than falling back to the rotation. There is no un-pin.
  pin: (date: string, partId: string, personId: string | null) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, assignments: [{ partId, personId }] })),

  // '' clears the theme; null would mean "leave whatever is there" — a cleared box keeping its text.
  setTheme: (date: string, theme: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, theme })),

  // One call both ways — a skip has to be undoable, and "planned" is the module's own word.
  setStatus: (date: string, status: 'planned' | 'skipped') =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, status })),

  // What a part IS. Sent WITHOUT `personId` on purpose: the server reads presence, so including
  // it would turn "I named the treat" into "…and nobody has it". '' clears; null means leave alone.
  setDetail: (date: string, partId: string, detail: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, assignments: [{ partId, detail }] })),

  // Point the gathering at an event that exists (`null` unlinks, leaving the event alone).
  linkEvent: (date: string, eventId: string | null) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, eventId })),

  // "Add this week to the calendar": ONE call that creates and links server-side. NOT
  // create-then-adopt, because the web writes events locally first and the id may not exist yet.
  addEvent: (date: string) =>
    alsoPlanning(familyNightApi.saveOccurrence({ date, createEvent: true })),
}

// The crumb this step hands the session record: what it DECIDED, not a copy of the module.
export function planningFamilyNightDecision(board: PlanningFamilyNightBoard | null): {
  pinned: string[]
  skipped: boolean
} {
  return {
    pinned: (board?.parts ?? []).filter((p) => p.pinned).map((p) => p.partId),
    skipped: board?.status === 'skipped',
  }
}
