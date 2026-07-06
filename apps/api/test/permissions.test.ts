// Capability matrix — pure unit tests (no DB). requireCapability is covered by the
// chores/rewards integration tests since it touches Postgres.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PERMISSIONS,
  getPermissions,
  can,
  resolveCapabilities,
  CAPABILITIES,
} from '../src/platform/permissions'

describe('DEFAULT_PERMISSIONS', () => {
  it('adult has every capability; teen and kid have none', () => {
    for (const cap of CAPABILITIES) {
      expect(DEFAULT_PERMISSIONS.adult[cap]).toBe(true)
      expect(DEFAULT_PERMISSIONS.teen[cap]).toBe(false)
      expect(DEFAULT_PERMISSIONS.kid[cap]).toBe(false)
    }
  })

  it('exposes the full capability set, including goal.manage', () => {
    expect(CAPABILITIES).toEqual([
      'chore.manage',
      'chore.approve',
      'reward.manage',
      'reward.approve',
      'reward.grant',
      'goal.manage',
    ])
    expect(DEFAULT_PERMISSIONS.adult['goal.manage']).toBe(true)
    expect(DEFAULT_PERMISSIONS.teen['goal.manage']).toBe(false)
    expect(DEFAULT_PERMISSIONS.kid['goal.manage']).toBe(false)
  })
})

describe('getPermissions', () => {
  it('returns the defaults for null/garbage/non-object settings', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { permissions: 'nope' }, { permissions: 42 }]) {
      expect(getPermissions(junk)).toEqual(DEFAULT_PERMISSIONS)
    }
  })

  it('deep-merges an override cell, leaving everything else at the default', () => {
    const merged = getPermissions({ permissions: { teen: { 'chore.approve': true } } })
    expect(merged.teen['chore.approve']).toBe(true)
    // siblings untouched
    expect(merged.teen['chore.manage']).toBe(false)
    expect(merged.teen['reward.manage']).toBe(false)
    expect(merged.adult).toEqual(DEFAULT_PERMISSIONS.adult)
    expect(merged.kid).toEqual(DEFAULT_PERMISSIONS.kid)
  })

  it('ignores unknown roles, unknown capabilities, and non-boolean values', () => {
    const merged = getPermissions({
      permissions: {
        teen: { 'chore.manage': true, 'bogus.cap': true, 'reward.manage': 'yes' },
        ghost: { 'chore.manage': true },
      },
    })
    expect(merged.teen['chore.manage']).toBe(true)
    expect(merged.teen['reward.manage']).toBe(false) // non-boolean ignored
    expect((merged.teen as Record<string, unknown>)['bogus.cap']).toBeUndefined()
    expect((merged as Record<string, unknown>).ghost).toBeUndefined()
  })
})

describe('can', () => {
  it('an admin always passes, even with an empty matrix or unknown role', () => {
    expect(can('kid', true, 'chore.manage', undefined)).toBe(true)
    expect(can('whatever', true, 'reward.approve', undefined)).toBe(true)
  })

  it('a non-admin is governed by the role row', () => {
    expect(can('adult', false, 'chore.manage', undefined)).toBe(true)
    expect(can('teen', false, 'chore.manage', undefined)).toBe(false)
    expect(can('teen', false, 'chore.approve', { permissions: { teen: { 'chore.approve': true } } })).toBe(true)
  })

  it('an unknown role has no capabilities', () => {
    expect(can('robot', false, 'chore.manage', undefined)).toBe(false)
  })
})

describe('resolveCapabilities', () => {
  it('admin gets the full list', () => {
    expect(resolveCapabilities('kid', true, undefined).sort()).toEqual([...CAPABILITIES].sort())
  })

  it('adult default gets all; teen default gets none', () => {
    expect(resolveCapabilities('adult', false, undefined).sort()).toEqual([...CAPABILITIES].sort())
    expect(resolveCapabilities('teen', false, undefined)).toEqual([])
  })

  it('reflects a granted cell', () => {
    expect(resolveCapabilities('teen', false, { permissions: { teen: { 'reward.approve': true } } })).toEqual([
      'reward.approve',
    ])
  })

  it('an unknown role gets nothing', () => {
    expect(resolveCapabilities('alien', false, undefined)).toEqual([])
  })
})
