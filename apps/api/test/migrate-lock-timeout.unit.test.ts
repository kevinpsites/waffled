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

  // Postgres rounds lock_timeout to whole ms and caps it at INT_MAX; 0 means "wait forever".
  it('rejects a non-zero value that would round down to wait-forever', () => {
    for (const tiny of ['0.4', '0.4ms', '0.0001s']) {
      expect(() => parseLockTimeout(tiny)).toThrow(/MIGRATE_LOCK_TIMEOUT/)
    }
    expect(parseLockTimeout('0.5')).toBe(1)
    expect(parseLockTimeout('0ms')).toBe(0)
  })

  it('rejects a value above the Postgres lock_timeout maximum', () => {
    expect(parseLockTimeout('2147483647')).toBe(2_147_483_647)
    for (const huge of ['2147483648', '597h']) {
      expect(() => parseLockTimeout(huge)).toThrow(/MIGRATE_LOCK_TIMEOUT must be 0, or between 1ms and 2147483647ms/)
    }
  })

  it('rejects anything else, naming the variable', () => {
    for (const bad of ['abc', '-5', '10 parsecs', '5s;drop table x', '1e3', 's']) {
      expect(() => parseLockTimeout(bad)).toThrow(/MIGRATE_LOCK_TIMEOUT/)
    }
  })
})
