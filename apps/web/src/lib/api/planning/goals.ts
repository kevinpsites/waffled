// Step 6 · Goals — this step's API client and its types.
//
// A read over the goal lists you already have plus ONE write: picking a group's focus, which
// sets that goal's existing `is_featured` flag. `settled`/`focusGoalId` are the SESSION's
// memory of what it decided, while `goals[].isFeatured` stays the goals module's truth.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'
import type { Goal, GoalListMember } from '../goals'

// How a goal is actually GOING, in one of three tones — derived server-side from real
// logged activity, so web and iOS read the same verdict.
export type PaceTone = 'ok' | 'flat' | 'behind'
export interface GoalPace {
  text: string
  tone: PaceTone
}

export interface PlanningGoalGoal extends Goal {
  pace: GoalPace | null
}

export interface PlanningGoalMember extends GoalListMember {
  // Null when we have no birthday on file — the sub line drops the age rather than guess.
  age: number | null
}

export interface PlanningGoalGroup {
  listId: string
  name: string
  emoji: string | null
  colorHex: string | null
  isPrivate: boolean
  sortOrder: number
  members: PlanningGoalMember[]
  // Literally every person, so the sub line can say "everyone" without counting people.
  isEveryone: boolean
  goals: PlanningGoalGoal[]
  // True once THIS session has answered — a pre-existing pin does not star a tab.
  settled: boolean
  // The focus: when settled, what the session answered (null is "nothing this week"); when
  // not, the list's one already-featured goal, which is how a new goal comes back selected.
  focusGoalId: string | null
}

export interface PlanningGoalsView {
  groups: PlanningGoalGroup[]
}

export const planningGoalsApi = {
  get: (sessionId: string) =>
    apiGet<PlanningGoalsView>(`/api/weekly-planning/goals?sessionId=${encodeURIComponent(sessionId)}`),
  // Emits `goals` too: the flag it sets is the goals module's, so that screen is now stale.
  setFocus: (sessionId: string, listId: string, goalId: string | null) =>
    apiSend<PlanningGoalsView>('PUT', '/api/weekly-planning/goals/focus', { sessionId, listId, goalId })
      .then((r) => { emit('goals'); emit('weeklyPlanning'); return r }),
}

// The crumb this step hands the session record, rebuilt from the server's answer and
// mirrored through `setDecisionData` (the primary REPLACES the step's data).
export function planningGoalsDecision(view: PlanningGoalsView | null): { focus: Record<string, string | null> } {
  const focus: Record<string, string | null> = {}
  for (const g of view?.groups ?? []) if (g.settled) focus[g.listId] = g.focusGoalId
  return { focus }
}
