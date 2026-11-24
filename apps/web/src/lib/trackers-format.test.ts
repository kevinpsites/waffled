import { formatLastTime, isoToZonedInput, zonedInputToIso } from './trackers-format'

describe('formatLastTime', () => {
  it('says Not logged yet with no entry', () => {
    expect(formatLastTime(null, 'America/Chicago')).toBe('Not logged yet')
  })

  it('formats in the household timezone', () => {
    expect(formatLastTime({ occurredAt: '2026-11-23T20:15:00Z', personName: null }, 'America/Chicago')).toBe('Last time: 11/23 2:15 PM')
  })

  it('appends the person', () => {
    expect(formatLastTime({ occurredAt: '2026-11-23T20:15:00Z', personName: 'Emma' }, 'America/Chicago')).toBe('Last time: 11/23 2:15 PM · Emma')
  })

  it('rolls the date back across UTC midnight', () => {
    expect(formatLastTime({ occurredAt: '2026-11-24T03:30:00Z', personName: null }, 'America/Los_Angeles')).toBe('Last time: 11/23 7:30 PM')
  })

  it('renders midnight and noon as 12', () => {
    expect(formatLastTime({ occurredAt: '2026-11-23T06:05:00Z', personName: null }, 'America/Chicago')).toBe('Last time: 11/23 12:05 AM')
    expect(formatLastTime({ occurredAt: '2026-11-23T18:00:00Z', personName: null }, 'America/Chicago')).toBe('Last time: 11/23 12:00 PM')
  })
})

describe('zoned datetime-local conversion', () => {
  it('renders an ISO instant as household wall time', () => {
    expect(isoToZonedInput('2026-11-23T20:15:00.000Z', 'America/Chicago')).toBe('2026-11-23T14:15')
  })

  it('converts wall time back to the same instant', () => {
    expect(zonedInputToIso('2026-11-23T14:15', 'America/Chicago')).toBe('2026-11-23T20:15:00.000Z')
  })

  it('round-trips across DST (CDT, UTC-5)', () => {
    const iso = '2026-07-04T01:30:00.000Z'
    expect(isoToZonedInput(iso, 'America/Chicago')).toBe('2026-07-03T20:30')
    expect(zonedInputToIso('2026-07-03T20:30', 'America/Chicago')).toBe(iso)
  })

  it('handles midnight (no 24:00)', () => {
    expect(isoToZonedInput('2026-11-23T06:00:00.000Z', 'America/Chicago')).toBe('2026-11-23T00:00')
    expect(zonedInputToIso('2026-11-23T00:00', 'America/Chicago')).toBe('2026-11-23T06:00:00.000Z')
  })

  it('returns null for an empty or invalid input', () => {
    expect(zonedInputToIso('', 'America/Chicago')).toBeNull()
  })

  it('resolves wall times after the spring-forward jump (CDT) and after fall-back (CST)', () => {
    expect(zonedInputToIso('2026-03-08T03:30', 'America/Chicago')).toBe('2026-03-08T08:30:00.000Z')
    expect(zonedInputToIso('2026-03-08T01:30', 'America/Chicago')).toBe('2026-03-08T07:30:00.000Z')
    expect(zonedInputToIso('2026-11-01T03:00', 'America/Chicago')).toBe('2026-11-01T09:00:00.000Z')
  })
})
