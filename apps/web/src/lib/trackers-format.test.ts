import { formatLastTime } from './trackers-format'

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
