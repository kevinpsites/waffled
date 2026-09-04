import { describe, expect, it } from 'vitest'
import { AccessEndDateError, expiryAfterAccessEndDate } from '../src/platform/access-expiry'

const beforeFixtures = new Date('2026-01-01T00:00:00.000Z')

describe('household-local access end dates', () => {
  it('uses exclusive next midnight across the spring DST boundary', () => {
    expect(expiryAfterAccessEndDate('2026-03-08', 'America/Los_Angeles', beforeFixtures)?.toISOString())
      .toBe('2026-03-09T07:00:00.000Z')
  })

  it('uses exclusive next midnight across the fall DST boundary', () => {
    expect(expiryAfterAccessEndDate('2026-11-01', 'America/New_York', beforeFixtures)?.toISOString())
      .toBe('2026-11-02T05:00:00.000Z')
  })

  it('keeps the same selected date in households on opposite sides of UTC', () => {
    expect(expiryAfterAccessEndDate('2026-06-15', 'Pacific/Kiritimati', beforeFixtures)?.toISOString())
      .toBe('2026-06-15T10:00:00.000Z')
    expect(expiryAfterAccessEndDate('2026-06-15', 'Pacific/Honolulu', beforeFixtures)?.toISOString())
      .toBe('2026-06-16T10:00:00.000Z')
  })

  it('rejects malformed, impossible, expired, and invalid-zone input', () => {
    expect(() => expiryAfterAccessEndDate('2026-6-15', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2026-02-30', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2025-12-31', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2026-06-15', 'Not/A_Zone', beforeFixtures)).toThrow(AccessEndDateError)
  })
})
