// Weekly Planning domain — the guided session that decides the week ahead.
//
// The step catalog (order, titles, the question each step asks) is SERVER-owned and arrives
// in the view; nothing here hardcodes it, so web and iOS can't drift on the session's
// shape. See docs/product/weekly-planning-plan.md.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { useRefetchOn, emit } from './bus'

export type StepStatus = 'pending' | 'done' | 'skipped'

/** A parked note waiting on this step — see `PlanningStep.parked`. */
export interface PlanningStepHandoff {
  id: string
  note: string
  /** "Kevin · 2 weeks ago", composed server-side so web and iOS say it the same way. */
  byline: string | null
}

export interface PlanningStep {
  key: string
  number: number
  title: string
  ask: string
  primary: string
  act: string
  requiresModule?: string
  // False ⇒ the module this step reads is off, or the household turned it off.
  available: boolean
  status: StepStatus
  data: Record<string, unknown>
  decidedAt: string | null
  /**
   * Open parked notes TAGGED FOR THIS STEP. Empty for `looseEnds` (which draws the whole
   * board) and for untagged notes (the recap's last call, not every step's banner).
   * Capped server-side: a nudge, not an inbox.
   */
  parked: PlanningStepHandoff[]
}

export interface PlanningSession {
  id: string
  weekStart: string
  status: 'active' | 'completed'
  currentStep: string | null
  driverPersonId: string | null
  startedAt: string
  completedAt: string | null
}

export interface WeeklyPlanningConfig {
  dayOfWeek: number
  time: string
  steps: Record<string, boolean>
  showOnToday: boolean
  /**
   * Which lists step 1 is even about, keyed by list id. ABSENT MEANS RELEVANT — a sparse
   * opt-out map like `steps`, so read it as `lists[id] !== false`. Patches merge server-side.
   */
  lists: Record<string, boolean>
}

// Defined once in the step's own api file: one server helper answers both this module's
// config read and step 1's. Re-exported, since callers reach for it from either place.
import type { PlanningListCandidate } from './planning/looseEnds'
export type { PlanningListCandidate }

export interface WeeklyPlanningView {
  config: WeeklyPlanningConfig
  weekStart: string
  defaultWeekStart: string
  // The earliest plannable week — the floor of the week stepper.
  minWeekStart: string
  session: PlanningSession | null
  steps: PlanningStep[]
}

export const weeklyPlanningApi = {
  get: (weekStart?: string) =>
    apiGet<WeeklyPlanningView>(`/api/weekly-planning${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''}`),
  getConfig: () =>
    apiGet<{ config: WeeklyPlanningConfig; steps: PlanningStep[]; lists: PlanningListCandidate[] }>(
      '/api/weekly-planning/config'
    ),
  setConfig: (patch: Partial<WeeklyPlanningConfig>) =>
    apiSend<{ config: WeeklyPlanningConfig }>('PUT', '/api/weekly-planning/config', patch).then((r) => { emit('weeklyPlanning'); return r }),
  startSession: (weekStart?: string) =>
    apiSend<{ session: PlanningSession }>('POST', '/api/weekly-planning/session', weekStart ? { weekStart } : {}).then((r) => { emit('weeklyPlanning'); return r }),
  patchSession: (id: string, patch: { currentStep?: string; status?: 'active' | 'completed' }) =>
    apiSend<{ session: PlanningSession }>('PATCH', `/api/weekly-planning/session/${id}`, patch).then((r) => { emit('weeklyPlanning'); return r }),
  decideStep: (id: string, stepKey: string, status: StepStatus, data?: Record<string, unknown>) =>
    apiSend<{ steps: PlanningStep[] }>('POST', `/api/weekly-planning/session/${id}/step`, { stepKey, status, data })
      .then((r) => { emit('weeklyPlanning'); return r }),
  complete: (id: string) =>
    apiSend<{ session: PlanningSession; steps: PlanningStep[] }>('POST', `/api/weekly-planning/session/${id}/complete`, {})
      .then((r) => { emit('weeklyPlanning'); return r }),
  // Discard the session and put the week back to its lobby. What the session decided stays
  // where it landed — this only throws away the session record.
  discard: (id: string) =>
    apiDelete(`/api/weekly-planning/session/${id}`).then((r) => { emit('weeklyPlanning'); return r }),
}

export const availableSteps = (steps: PlanningStep[]): PlanningStep[] => steps.filter((s) => s.available)

// The acts, in catalog order, each with its available steps. Drives the agenda sheet's
// "Act 2 · Frame the week" grouping without hardcoding the acts on the client.
export function stepsByAct(steps: PlanningStep[]): { act: string; steps: PlanningStep[] }[] {
  const out: { act: string; steps: PlanningStep[] }[] = []
  for (const s of availableSteps(steps)) {
    const last = out[out.length - 1]
    if (last && last.act === s.act) last.steps.push(s)
    else out.push({ act: s.act, steps: [s] })
  }
  return out
}

// In order: the step named in the URL, then the session's own pointer (which lets another
// device resume where this one left off), then the first runnable step. An unavailable key
// must never strand the session on a blank screen.
export function resolveCurrent(view: WeeklyPlanningView | null, urlStep?: string | null): PlanningStep | null {
  if (!view) return null
  const avail = availableSteps(view.steps)
  if (!avail.length) return null
  return avail.find((s) => s.key === urlStep) ?? avail.find((s) => s.key === view.session?.currentStep) ?? avail[0]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const addWeeks = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * WEEK_MS).toISOString().slice(0, 10)

export const nextStepAfter = (steps: PlanningStep[], key: string): PlanningStep | null => {
  const avail = availableSteps(steps)
  const i = avail.findIndex((s) => s.key === key)
  return i >= 0 && i + 1 < avail.length ? avail[i + 1] : null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const planningDayName = (dow: number) => WEEKDAYS[((dow % 7) + 7) % 7] ?? 'Sunday'

export function useWeeklyPlanning(weekStart?: string) {
  const [view, setView] = useState<WeeklyPlanningView | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const refetch = () => setNonce((n) => n + 1)
  useRefetchOn(['weeklyPlanning'], refetch)
  useEffect(() => {
    let alive = true
    weeklyPlanningApi.get(weekStart)
      .then((d) => { if (alive) { setView(d); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [nonce, weekStart])
  return { view, loading, refetch }
}
