// Optional, opt-in feature modules — UI mirror of apps/api/src/platform/modules.ts.
// Enablement lives server-side in households.settings.modules; see
// docs/product/extensibility.md.
import type { Household } from './api'

export type ModuleKey = 'pantry' | 'fhe' | 'quotes'

export interface ModuleDef {
  key: ModuleKey
  name: string
  icon: string
  description: string
  status: 'available' | 'planned'
  defaultOn: boolean
}

export const MODULES: ModuleDef[] = [
  {
    key: 'pantry',
    name: 'Pantry',
    icon: '🥫',
    description: "Track what's actually on hand (freezer/fridge/pantry) and let it feed meal planning.",
    status: 'planned',
    defaultOn: false,
  },
  {
    key: 'fhe',
    name: 'Family Home Evening',
    icon: '🏠',
    description: 'A weekly family meeting with a structured agenda, assignments, and a Today card.',
    status: 'planned',
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

// Is a module enabled for this household? Reads settings.modules[key] with the catalog
// default as fallback; not-yet-built ('planned') modules are always off.
export function moduleEnabled(household: Household | null | undefined, key: ModuleKey): boolean {
  const def = MODULES.find((m) => m.key === key)
  if (!def || def.status !== 'available') return false
  const v = household?.settings?.modules?.[key]
  return typeof v === 'boolean' ? v : def.defaultOn
}
