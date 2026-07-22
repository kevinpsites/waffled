// Per-goal "last selected data view" — plain localStorage, keyed per goal, matching
// this app's existing convention (direct getItem/setItem calls colocated with the
// feature; no generic settings/preferences hook exists yet).
import type { ViewKey } from '../../lib/goalStats'

const key = (goalId: string): string => `waffled.goalView.${goalId}`

export function getSavedView(goalId: string): ViewKey | null {
  try {
    return (localStorage.getItem(key(goalId)) as ViewKey | null) ?? null
  } catch {
    return null
  }
}

export function saveView(goalId: string, view: ViewKey): void {
  try {
    localStorage.setItem(key(goalId), view)
  } catch {
    // Storage unavailable (private mode, quota) — the switcher just won't persist.
  }
}
