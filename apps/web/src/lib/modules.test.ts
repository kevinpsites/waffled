import { describe, it, expect } from 'vitest'
import { MODULES, moduleEnabled, type ModuleKey } from './modules'
import { SCREENS } from '../kiosk/nav'
import type { Household } from './api'

// Minimal Household stub carrying just the module flags moduleEnabled reads.
function hh(modules?: Record<string, boolean>): Household {
  return { settings: { modules } } as unknown as Household
}

const CORE: ModuleKey[] = ['chores', 'goals', 'rewards', 'meals', 'lists']

describe('module catalog', () => {
  it('the five core feature modules are available and default ON', () => {
    for (const key of CORE) {
      const def = MODULES.find((m) => m.key === key)
      expect(def, `${key} missing from catalog`).toBeTruthy()
      expect(def!.status).toBe('available')
      expect(def!.defaultOn).toBe(true)
    }
  })

  it('defaults to on (null household / no override) and respects an explicit override', () => {
    expect(moduleEnabled(null, 'meals')).toBe(true)
    expect(moduleEnabled(hh({}), 'meals')).toBe(true)
    expect(moduleEnabled(hh({ meals: false }), 'meals')).toBe(false)
    expect(moduleEnabled(hh({ meals: false }), 'goals')).toBe(true)
  })

  it('planned modules are never enabled', () => {
    expect(moduleEnabled(hh({ fhe: true }), 'fhe')).toBe(false)
  })
})

describe('rail nav gating', () => {
  const visible = (household: Household | null) =>
    SCREENS.filter((s) => !s.module || moduleEnabled(household, s.module)).map((s) => s.path)

  it('Today + Calendar are never module-gated', () => {
    expect(SCREENS.find((s) => s.path === '/')?.module).toBeUndefined()
    expect(SCREENS.find((s) => s.path === '/calendar')?.module).toBeUndefined()
  })

  it('the core pages carry their module flag', () => {
    expect(SCREENS.find((s) => s.path === '/tasks')?.module).toBe('chores')
    expect(SCREENS.find((s) => s.path === '/goals')?.module).toBe('goals')
    expect(SCREENS.find((s) => s.path === '/meals')?.module).toBe('meals')
    expect(SCREENS.find((s) => s.path === '/lists')?.module).toBe('lists')
  })

  it('hides a disabled page but keeps Today/Calendar/Family/Photos', () => {
    const paths = visible(hh({ meals: false, lists: false }))
    expect(paths).not.toContain('/meals')
    expect(paths).not.toContain('/lists')
    expect(paths).toContain('/')
    expect(paths).toContain('/calendar')
    expect(paths).toContain('/family')
    expect(paths).toContain('/tasks')
  })
})
