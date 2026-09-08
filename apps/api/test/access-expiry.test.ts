import { describe, expect, it } from 'vitest'
import {
  AccessEndDateError,
  accessEndDateBeforeExpiry,
  canonicalAccessWindow,
  expiryAfterAccessEndDate,
  normalizeHouseholdTimezone,
} from '../src/platform/access-expiry'

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

  it('canonicalizes a legacy exclusive instant to its household civil end date', () => {
    expect(accessEndDateBeforeExpiry('2026-06-16T06:00:00.000Z', 'America/Denver'))
      .toBe('2026-06-15')
    // A partial local day is rounded down, never forward into a later deadline.
    expect(accessEndDateBeforeExpiry('2026-06-16T18:00:00.000Z', 'America/Denver'))
      .toBe('2026-06-15')
    // Shipped iOS and web clients encoded the selected day at 23:59:59(.999).
    expect(accessEndDateBeforeExpiry('2026-06-16T05:59:59.000Z', 'America/Denver'))
      .toBe('2026-06-15')
    expect(accessEndDateBeforeExpiry('2026-06-16T05:59:59.999Z', 'America/Denver'))
      .toBe('2026-06-15')
  })

  it('rejects malformed, impossible, expired, and invalid-zone input', () => {
    expect(() => expiryAfterAccessEndDate('2026-6-15', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2026-02-30', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2025-12-31', 'UTC', beforeFixtures)).toThrow(AccessEndDateError)
    expect(() => expiryAfterAccessEndDate('2026-06-15', 'Not/A_Zone', beforeFixtures)).toThrow(AccessEndDateError)
  })

  it('normalizes valid IANA zones and rejects invalid household timezone writes', () => {
    expect(normalizeHouseholdTimezone('  America/Denver  ')).toBe('America/Denver')
    expect(() => normalizeHouseholdTimezone('Mars/Olympus')).toThrow(AccessEndDateError)
    expect(() => normalizeHouseholdTimezone(42)).toThrow(AccessEndDateError)
  })

  it('rejects a future legacy instant whose canonical complete civil day is already over', () => {
    const now = new Date('2026-06-16T18:00:00.000Z')
    // 12:01 in Denver is still a future exact instant, but conservative legacy
    // canonicalization selects June 15, whose exclusive midnight has passed.
    expect(() => canonicalAccessWindow(
      { accessExpiresAt: '2026-06-16T18:01:00.000Z' },
      'America/Denver',
      now
    )).toThrow(AccessEndDateError)
  })
})
