// Optional, opt-in feature modules. The code ships in the app; each household turns
// them on/off in Settings → Modules (stored in households.settings.modules). See
// docs/product/extensibility.md for the A/B/C pattern model.

export type ModuleKey = 'pantry' | 'chores' | 'goals' | 'meals' | 'lists' | 'familyNight' | 'quotes'

export interface ModuleDef {
  key: ModuleKey
  name: string
  icon: string
  description: string
  // 'available' = built & shippable (togglable); 'planned' = on the roadmap, shown as
  // "coming soon" in the Modules tab but not yet togglable.
  status: 'available' | 'planned'
  defaultOn: boolean
}

// The catalog. Mirrored (by hand) in apps/web/src/lib/modules.ts for the UI.
export const MODULES: ModuleDef[] = [
  {
    key: 'pantry',
    name: 'Pantry',
    icon: '🥫',
    description: "Track what's actually on hand (freezer/fridge/pantry) and let it feed meal planning.",
    status: 'available',
    defaultOn: false,
  },
  // Core feature pages. On by default (so existing households are unchanged); a
  // household can turn off whichever it doesn't use. Today + Calendar are never
  // gated. Dependencies degrade softly (e.g. rewards is funded by chores; with
  // chores off the reward jar simply has nothing feeding it).
  {
    key: 'chores',
    name: 'Chores & Tasks',
    icon: '✅',
    description: 'The Tasks board — assignable chores, photo proof, approvals, and stars.',
    status: 'available',
    defaultOn: true,
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
  },
  {
    key: 'quotes',
    name: 'Daily quote',
    icon: '💬',
    description: 'A preloadable daily quote or snippet on the Today tab.',
    status: 'planned',
    defaultOn: false,
  },
]

export const MODULE_KEYS = new Set<string>(MODULES.map((m) => m.key))

// Is a module enabled for a household? Reads settings.modules[key], falling back to the
// catalog default. Planned (not-yet-built) modules are always treated as off.
export function moduleEnabled(settings: unknown, key: ModuleKey): boolean {
  const def = MODULES.find((m) => m.key === key)
  if (!def || def.status !== 'available') return false
  const m = (settings as { modules?: Record<string, unknown> } | null | undefined)?.modules
  const v = m?.[key]
  return typeof v === 'boolean' ? v : def.defaultOn
}

// Rewards is the "spend" half of the chores economy, not its own module: it's a
// sub-toggle of chores (settings.chores.rewards, default on). It can never be on
// without chores — so a reward shop always has a way to earn. Off either when
// chores is off or the sub-flag is explicitly false.
export function rewardsEnabled(settings: unknown): boolean {
  if (!moduleEnabled(settings, 'chores')) return false
  const v = (settings as { chores?: { rewards?: unknown } } | null | undefined)?.chores?.rewards
  return typeof v === 'boolean' ? v : true
}
