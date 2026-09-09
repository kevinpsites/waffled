import type { ComponentType } from 'react'
import type { PlanningStep } from '../../lib/api'

// THE CONTRACT BETWEEN THE SHELL AND A STEP. The shell owns the chrome; each step owns
// only what goes between. All ten keys point at all ten files here, so building a step
// means editing that step's own files and nothing else.
export interface StepBodyProps {
  step: PlanningStep
  sessionId: string
  // The week being planned. ALWAYS use this rather than computing a week client-side —
  // the server owns the boundary.
  weekStart: string
  // Attach the crumb this step wants kept on the session record; null clears it. NEVER a
  // copy of module data — the recap reads through to the modules.
  //
  // ONLY PERSISTED WHEN THE STEP IS ANSWERED: the shell holds it until Skip or the
  // affirmative sends it, so it is a hint, never the authority for anything a step must
  // find again. A step needing a mid-step write calls its own route.
  setDecisionData: (data: Record<string, unknown> | null) => void
  // Re-read the session view; call it after writing into another module.
  refresh: () => void
  // A write is in flight; disable your own controls.
  busy: boolean
}

export interface PlanningStepModule {
  Body: ComponentType<StepBodyProps>
  // Optional: one more control in the footer, beside Skip and the affirmative. Only
  // Meals uses it.
  FooterExtra?: ComponentType<StepBodyProps>
}

// Lazily imported so a step's code (and its chunk) only loads when someone reaches it.
export const STEP_MODULES: Record<string, () => Promise<PlanningStepModule>> = {
  looseEnds: () => import('./steps/LooseEndsStep').then((m) => m.default),
  calendar: () => import('./steps/CalendarStep').then((m) => m.default),
  horizon: () => import('./steps/HorizonStep').then((m) => m.default),
  familyNight: () => import('./steps/FamilyNightStep').then((m) => m.default),
  connection: () => import('./steps/ConnectionStep').then((m) => m.default),
  goals: () => import('./steps/GoalsStep').then((m) => m.default),
  meals: () => import('./steps/MealsStep').then((m) => m.default),
  tasks: () => import('./steps/TasksStep').then((m) => m.default),
  kids: () => import('./steps/KidsStep').then((m) => m.default),
  recap: () => import('./steps/RecapStep').then((m) => m.default),
}
