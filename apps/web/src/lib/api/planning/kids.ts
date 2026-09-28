// Step 9 · Kids — this step's API client and its types. A read over the kids' OWN goals, chores
// and calendar, plus two answers that have no other module to land in; nothing here invents an
// option.
//
// A goal-sourced option carries `goal` — the same shape the goals screen gets — so the card
// renders its number through the SHARED display helpers, which is what keeps a habit reading as
// this period's count rather than a lifetime total.
//
// The answers are a REAL write (see kids.routes.ts), not `setDecisionData`: the read-back frame
// has to survive a remount, a refresh and a change of device.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'
import type { Goal } from '../goals'

// Where an option came from. `routine` is a standing chore they already carry.
export type PlanningKidFocusSource = 'goal' | 'chore' | 'routine' | 'custom'

export interface PlanningKidFocusOption {
  // Stable across refetches and unique across sources. A chore step 1 routed here and the same
  // chore found overdue share one key on purpose — triage promotes, never duplicates.
  key: string
  source: PlanningKidFocusSource
  id: string | null
  emoji: string
  label: string
  // The line under the label. NULL is meaningful: a standing chore has nothing late about it.
  detail: string | null
  routed: boolean
  // The whole goal, so the number is read through the shared display helper instead of an
  // inline `totalProgress`.
  goal: Goal | null
}

export interface PlanningKidForwardOption {
  key: string
  eventId: string | null
  emoji: string
  label: string
  when: string
}

export interface PlanningKidEvent {
  id: string
  title: string
  when: string
  startsAt: string
  allDay: boolean
}

export interface PlanningKidChore {
  id: string
  title: string
  emoji: string | null
  when: string
  late: boolean
}

// What a card settled on — a SNAPSHOT of the label as it read when chosen. The module still
// owns the item; this is what lets the read-back render without re-reading four modules.
export interface PlanningKidFocus {
  source: PlanningKidFocusSource
  id: string | null
  emoji: string
  label: string
  detail: string | null
}
export interface PlanningKidForward {
  eventId: string | null
  emoji: string
  label: string
  when: string
}

export interface PlanningKidCard {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  // Null when there's no birthday on file — the card drops the age rather than guessing.
  age: number | null
  stars: number | null
  starsSymbol: string | null
  week: PlanningKidEvent[]
  chores: PlanningKidChore[]
  focusOptions: PlanningKidFocusOption[]
  forwardOptions: PlanningKidForwardOption[]
  focus: PlanningKidFocus | null
  forward: PlanningKidForward | null
  settled: boolean
}

export interface PlanningKidsView {
  weekStart: string
  kids: PlanningKidCard[]
  // Which modules actually contributed, so an empty card can say why rather than look broken.
  sources: { goals: boolean; chores: boolean; rewards: boolean }
  canRepeat: boolean
}

// One answer, on the wire. `null` clears it; an OMITTED key leaves it alone — the two questions
// are answered one at a time, and sending half must not erase the other half.
export type PlanningKidPick = { key: string } | { text: string } | null

export const planningKidsApi = {
  get: (sessionId: string, weekStart?: string) =>
    apiGet<PlanningKidsView>(
      `/api/weekly-planning/kids?sessionId=${encodeURIComponent(sessionId)}` +
        (weekStart ? `&weekStart=${encodeURIComponent(weekStart)}` : '')
    ),
  // Emits `weeklyPlanning` only: the answer lands on the SESSION, not in goals or chores.
  answer: (
    sessionId: string,
    personId: string,
    body: { focus?: PlanningKidPick; forward?: PlanningKidPick },
    weekStart?: string
  ) =>
    apiSend<PlanningKidsView>('PUT', '/api/weekly-planning/kids/answer', { sessionId, personId, weekStart, ...body })
      .then((r) => { emit('weeklyPlanning'); return r }),
  // "Same as last week" — additive, and it only copies answers whose referent still stands.
  repeat: (sessionId: string, weekStart?: string) =>
    apiSend<PlanningKidsView>('POST', '/api/weekly-planning/kids/repeat', { sessionId, weekStart })
      .then((r) => { emit('weeklyPlanning'); return r }),
}

// The crumb this step hands the session record. Rebuilt from the server's answer after every
// read and write, and mirrored through `setDecisionData` so pressing the primary (which
// REPLACES the step's data) writes back what is already there instead of erasing it.
export function planningKidsDecision(view: PlanningKidsView | null): {
  kids: Record<string, { focus: PlanningKidFocus | null; forward: PlanningKidForward | null }>
} {
  const kids: Record<string, { focus: PlanningKidFocus | null; forward: PlanningKidForward | null }> = {}
  for (const k of view?.kids ?? []) {
    if (k.focus || k.forward) kids[k.personId] = { focus: k.focus, forward: k.forward }
  }
  return { kids }
}
