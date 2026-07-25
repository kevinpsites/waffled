// Optional, opt-in feature modules — UI mirror of apps/api/src/platform/modules.ts.
// Enablement lives server-side in households.settings.modules; see
// docs/product/extensibility.md.
import type { Household } from './api'

export type ModuleKey = 'pantry' | 'chores' | 'goals' | 'meals' | 'lists' | 'familyNight' | 'quotes' | 'waffledBites'

export interface ModuleDef {
  key: ModuleKey
  name: string
  icon: string
  description: string
  status: 'available' | 'planned'
  defaultOn: boolean
  // Whether the module has its own settings panel (shown in Settings → Modules when on).
  hasSettings?: boolean
}

export const MODULES: ModuleDef[] = [
  {
    key: 'pantry',
    name: 'Pantry',
    icon: '🥫',
    description: "Track what's actually on hand (freezer/fridge/pantry) and let it feed meal planning.",
    status: 'available',
    defaultOn: false,
    hasSettings: true,
  },
  // Core feature pages — on by default; a household turns off what it doesn't use.
  // Today + Calendar are never gated. (Mirror of apps/api/src/platform/modules.ts.)
  {
    key: 'chores',
    name: 'Chores & Tasks',
    icon: '✅',
    description: 'The Tasks board — assignable chores, photo proof, approvals, and stars.',
    status: 'available',
    defaultOn: true,
    hasSettings: true,
  },
  {
    key: 'goals',
    name: 'Goals',
    icon: '🎯',
    description: 'Personal and family goals with progress tracking, streaks, and checklists.',
    status: 'available',
    defaultOn: true,
  },
  {
    key: 'meals',
    name: 'Meals & Recipes',
    icon: '🍽️',
    description: 'Recipe library, weekly meal planning, and meals on the calendar.',
    status: 'available',
    defaultOn: true,
  },
  {
    key: 'lists',
    name: 'Lists & Groceries',
    icon: '🛒',
    description: 'Shared lists and the auto-built grocery board (used by Pantry and Meals).',
    status: 'available',
    defaultOn: true,
  },
  {
    key: 'familyNight',
    name: 'Family Night',
    icon: '🏡',
    description: 'A recurring family gathering with a customizable agenda whose parts auto-rotate among members. Adds a Today card and can put it on the calendar.',
    status: 'available',
    defaultOn: false,
    hasSettings: true,
  },
  {
    key: 'quotes',
    name: 'Daily quote',
    icon: '💬',
    description: 'A preloadable daily quote or snippet on the Today tab.',
    status: 'planned',
    defaultOn: false,
  },
  {
    key: 'waffledBites',
    name: 'Waffled-Bites',
    icon: '🧇',
    description: "Pair a kid's Waffled-Bite device — quiet time, night light, wake-up light, sound machine, and their routines, controlled from Family.",
    status: 'available',
    defaultOn: false,
  },
]

// Is a module enabled for this household? Reads settings.modules[key] with the catalog
// default as fallback; not-yet-built ('planned') modules are always off.
export function moduleEnabled(household: Household | null | undefined, key: ModuleKey): boolean {
  const def = MODULES.find((m) => m.key === key)
  if (!def || def.status !== 'available') return false
  const v = household?.settings?.modules?.[key]
  return typeof v === 'boolean' ? v : def.defaultOn
}

// Rewards is the spend half of the chores economy, not its own module: a sub-toggle
// (settings.chores.rewards, default on) that can never be on without chores. Mirror
// of rewardsEnabled() in apps/api/src/platform/modules.ts.
export function rewardsEnabled(household: Household | null | undefined): boolean {
  if (!moduleEnabled(household, 'chores')) return false
  const v = household?.settings?.chores?.rewards
  return typeof v === 'boolean' ? v : true
}
