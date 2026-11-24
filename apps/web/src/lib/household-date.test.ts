import { describe, it, expect } from 'vitest'
import { householdToday, addDaysYmd } from './household-date'

describe('household-date', () => {
  it('computes today in the household timezone', () => {
    expect(householdToday('America/Chicago', new Date('2026-11-25T05:30:00Z'))).toBe('2026-11-24')
    expect(householdToday('UTC', new Date('2026-11-25T05:30:00Z'))).toBe('2026-11-25')
  })
  it('adds days across month and year boundaries', () => {
    expect(addDaysYmd('2026-11-28', 6)).toBe('2026-12-04')
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28')
  })
})
