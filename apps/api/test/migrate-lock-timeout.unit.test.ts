import { describe, it, expect } from 'vitest'
import { DEFAULT_LOCK_TIMEOUT_MS, parseLockTimeout } from '../src/migrate'

describe('parseLockTimeout (MIGRATE_LOCK_TIMEOUT)', () => {
  it('falls back to the default when unset or blank', () => {
    expect(parseLockTimeout(undefined)).toBe(DEFAULT_LOCK_TIMEOUT_MS)
    expect(parseLockTimeout('')).toBe(DEFAULT_LOCK_TIMEOUT_MS)
    expect(parseLockTimeout('   ')).toBe(DEFAULT_LOCK_TIMEOUT_MS)
  })

  it('reads a bare number as milliseconds, like Postgres does', () => {
    expect(parseLockTimeout('5000')).toBe(5000)
    expect(parseLockTimeout('0')).toBe(0)
  })

  it('accepts Postgres time units', () => {
    expect(parseLockTimeout('500ms')).toBe(500)
    expect(parseLockTimeout('15s')).toBe(15_000)
    expect(parseLockTimeout('30 s')).toBe(30_000)
    expect(parseLockTimeout('1.5s')).toBe(1_500)
    expect(parseLockTimeout('2min')).toBe(120_000)
    expect(parseLockTimeout('1h')).toBe(3_600_000)
  })

  it('rejects anything else, naming the variable', () => {
    for (const bad of ['abc', '-5', '10 parsecs', '5s;drop table x', '1e3', 's']) {
      expect(() => parseLockTimeout(bad)).toThrow(/MIGRATE_LOCK_TIMEOUT/)
    }
  })
})
