// Weekly Planning · step 10 "Recap" — this step's API client and its types.
//
// ONE READ, AND NO WRITE AT ALL: saving the week is the shell's
// `POST /session/:id/complete`, and every line the recap shows is already live in the
// module that owns it — every line is a pointer, never a copy. All the joining happens
// server-side so web and iOS cannot each invent their own reading of the week.
import { apiGet } from '../client'

export interface PlanningRecapDay {
  date: string
  /** The dinner planned for that night. Null with the meals module off, too. */
  meal: string | null
  cook: string | null
  /** The colour INPUTS, not a colour: the strip tints each event through the app's own
   *  `useEventColor()`, so the week read back matches the calendar it describes. */
  events: {
    id: string
    title: string
    when: string
    personId: string | null
    personName: string | null
    personColor: string | null
    participantIds: string[]
  }[]
  /** Events the column is holding back, so a busy day says "+2 more" instead of growing. */
  more: number
}

export interface PlanningRecapGroup {
  key: string
  label: string
  headline: string
  detail: string
  count: number
  stepKey: string | null
}

export interface PlanningRecapLastCall {
  id: string
  note: string
  /** "Parked by Kevin · 2 weeks ago · passed over 3 times" — step 1's own line. */
  detail: string | null
}

export interface PlanningRecapLeftAlone {
  key: string
  label: string
  detail: string
  /** 'skipped' — passed over on purpose · 'none' — answered with nothing · 'parked'. */
  badge: 'skipped' | 'none' | 'parked'
  stepKey: string | null
}

export interface PlanningRecapView {
  weekStart: string
  savedAt: string | null
  days: PlanningRecapDay[]
  groups: PlanningRecapGroup[]
  lastCall: PlanningRecapLastCall[]
  lastCallMore: number
  leftAlone: PlanningRecapLeftAlone[]
  counts: { decisions: number; deferred: number; parked: number }
}

export const planningRecapApi = {
  get: (sessionId: string) =>
    apiGet<PlanningRecapView>(`/api/weekly-planning/recap?sessionId=${encodeURIComponent(sessionId)}`),
}

// The crumb the step hands the session record when the week is saved.
//
// INTEGERS ONLY — the pointer rule applied to storage: how MANY decisions were made is a
// fact about the session, but WHAT they were lives in the modules and would go stale.
export const planningRecapDecision = (view: PlanningRecapView | null) =>
  view ? { counts: view.counts } : null
