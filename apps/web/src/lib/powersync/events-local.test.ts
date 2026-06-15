import { describe, it, expect } from 'vitest'
import { localDate, rowToAgenda, eventsForDay, eventsForRange, type LocalEventRow } from './events-local'

function row(p: Partial<LocalEventRow>): LocalEventRow {
  return {
    id: 'e',
    title: 'Event',
    description: null,
    location: null,
    starts_at: '2026-06-24T22:00:00Z',
    ends_at: null,
    all_day: 0,
    person_id: null,
    person_name: null,
    person_color: null,
    person_emoji: null,
    participants_json: null,
    ...p,
  }
}

describe('localDate', () => {
  it('buckets an instant by the given timezone, not UTC', () => {
    // 01:00Z is the previous evening in Chicago (UTC-5 in June).
    expect(localDate('2026-06-24T01:00:00Z', 'America/Chicago')).toBe('2026-06-23')
    expect(localDate('2026-06-24T05:00:00Z', 'America/Chicago')).toBe('2026-06-24')
    expect(localDate('2026-06-24T01:00:00Z', 'UTC')).toBe('2026-06-24')
  })

  it('respects DST offsets (Intl is DST-aware)', () => {
    // Chicago is UTC-6 in January, UTC-5 in July — same wall-clock 23:30 local.
    expect(localDate('2026-01-15T05:30:00Z', 'America/Chicago')).toBe('2026-01-14')
    expect(localDate('2026-07-15T04:30:00Z', 'America/Chicago')).toBe('2026-07-14')
  })
})

describe('rowToAgenda', () => {
  it('coerces all_day to boolean and parses participants', () => {
    const a = rowToAgenda(
      row({
        all_day: 1,
        person_id: 'p1',
        person_name: 'Kevin',
        person_color: '#fff',
        person_emoji: '🐻',
        participants_json: '[{"id":"p1","name":"Kevin","colorHex":"#fff","avatarEmoji":"🐻"}]',
      })
    )
    expect(a.allDay).toBe(true)
    expect(a.personName).toBe('Kevin')
    expect(a.participants).toHaveLength(1)
    expect(a.participants[0]).toMatchObject({ id: 'p1', name: 'Kevin' })
  })

  it('tolerates null / malformed participants json', () => {
    expect(rowToAgenda(row({ participants_json: null })).participants).toEqual([])
    expect(rowToAgenda(row({ participants_json: 'not json' })).participants).toEqual([])
  })
})

describe('eventsForDay', () => {
  const tz = 'America/Chicago'
  const rows = [
    row({ id: 'allday', title: 'Trip', all_day: 1, starts_at: '2026-06-24T05:00:00Z' }),
    row({ id: 'noon', title: 'Lunch', starts_at: '2026-06-24T17:00:00Z' }), // 12:00 CDT
    row({ id: 'morning', title: 'Standup', starts_at: '2026-06-24T14:00:00Z' }), // 09:00 CDT
    row({ id: 'other', title: 'Tomorrow', starts_at: '2026-06-25T17:00:00Z' }),
  ]

  it('keeps only that local day and orders timed-before-all-day, then by start', () => {
    const out = eventsForDay(rows, tz, '2026-06-24')
    expect(out.map((e) => e.id)).toEqual(['morning', 'noon', 'allday'])
  })

  it('orders correctly across mixed timestamp formats (ISO vs Postgres text)', () => {
    const mixed = [
      row({ id: 'five', starts_at: '2026-06-24 22:00:00+00' }), // server (Postgres) format, 5pm CDT
      row({ id: 'noon', starts_at: '2026-06-24T17:00:00.000Z' }), // local (ISO) format, 12pm CDT
    ]
    expect(eventsForDay(mixed, tz, '2026-06-24').map((e) => e.id)).toEqual(['noon', 'five'])
  })
})

describe('eventsForRange', () => {
  const tz = 'America/Chicago'
  const rows = [
    row({ id: 'a', starts_at: '2026-06-23T14:00:00Z' }),
    row({ id: 'b', starts_at: '2026-06-25T14:00:00Z' }),
    row({ id: 'c', starts_at: '2026-07-02T14:00:00Z' }), // outside
  ]
  it('includes events whose local date is within [from,to], ordered by start', () => {
    const out = eventsForRange(rows, tz, '2026-06-23', '2026-06-30')
    expect(out.map((e) => e.id)).toEqual(['a', 'b'])
  })
})
