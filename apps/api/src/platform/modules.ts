// Optional, opt-in feature modules. The code ships in the app; each household turns
// them on/off in Settings → Modules (stored in households.settings.modules). See
// docs/product/extensibility.md for the A/B/C pattern model.

export type ModuleKey = 'pantry' | 'fhe' | 'quotes'

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
