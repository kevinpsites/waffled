// Pure unit tests for RRULE expansion (no DB needed). Covers cadence, rdate/exdate,
// overrides (move/cancel), DST correctness, the recurrence_end_at clamp, and the
// open-ended-rule horizon guard.
import { describe, it, expect } from 'vitest'
import { expand, type MasterEvent, type OverrideRow } from '../src/modules/calendar/recurrence'

const CHI = 'America/Chicago'
// 2026-01-06 is a Tuesday. 09:00 America/Chicago (CST, UTC-6) = 15:00Z.
const tueStart = new Date('2026-01-06T15:00:00Z')

function master(over: Partial<MasterEvent> = {}): MasterEvent {
  return {
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    startsAt: tueStart,
    endsAt: new Date('2026-01-06T16:00:00Z'), // 1h
    timezone: CHI,
    title: 'Soccer',
    location: 'Field',
    personId: 'p1',
    ...over,
  }
}

const localTime = (d: Date, tz = CHI) =>
  d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })

describe('expand', () => {
  it('expands a weekly series within a window (inclusive of dtstart)', () => {
    const occ = expand(master(), [], new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))
    // Tuesdays in January 2026: 6, 13, 20, 27
    expect(occ).toHaveLength(4)
    expect(occ[0].startsAt.toISOString()).toBe('2026-01-06T15:00:00.000Z')
    expect(occ[3].startsAt.toISOString()).toBe('2026-01-27T15:00:00.000Z')
    // duration carried (1h) + fields inherited from the master
    expect(occ[0].endsAt?.toISOString()).toBe('2026-01-06T16:00:00.000Z')
    expect(occ[0].title).toBe('Soccer')
    expect(occ[0].personId).toBe('p1')
    expect(occ[0].overrideId).toBeNull()
  })

  it('handles INTERVAL (every other week)', () => {
    const occ = expand(
      master({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' }),
      [],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-15T00:00:00Z'),
    )
    // Jan 6, 20, Feb 3 — every other Tuesday from the 6th
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual([
      '2026-01-06T15:00:00.000Z',
      '2026-01-20T15:00:00.000Z',
      '2026-02-03T15:00:00.000Z',
    ])
  })

  it('expands "last Friday of the month"', () => {
    const start = new Date('2026-01-30T18:00:00Z') // last Fri Jan 2026
    const occ = expand(
      master({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR', startsAt: start, endsAt: null }),
      [],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-04-01T00:00:00Z'),
    )
    // Last Fridays: Jan 30, Feb 27, Mar 27
    expect(occ).toHaveLength(3)
    expect(occ[1].startsAt.toISOString()).toBe('2026-02-27T18:00:00.000Z')
    expect(occ[0].endsAt).toBeNull() // no master end → null duration
  })

  it('keeps the local wall-clock time across a DST spring-forward', () => {
    // US DST 2026 starts Sun Mar 8. A daily 9am event must STAY 9am local
    // (the absolute UTC instant shifts from 15:00Z to 14:00Z after the change).
    const occ = expand(
      master({ rrule: 'FREQ=DAILY', endsAt: null }),
      [],
      new Date('2026-03-06T00:00:00Z'),
      new Date('2026-03-11T00:00:00Z'),
    )
    for (const o of occ) expect(localTime(o.startsAt)).toBe('09:00')
    const before = occ.find((o) => o.startsAt < new Date('2026-03-08T08:00:00Z'))!
    const after = occ.find((o) => o.startsAt > new Date('2026-03-09T00:00:00Z'))!
    expect(before.startsAt.toISOString().endsWith('15:00:00.000Z')).toBe(true) // CST
    expect(after.startsAt.toISOString().endsWith('14:00:00.000Z')).toBe(true) // CDT
  })

  it('drops exdate slots and adds rdate slots', () => {
    const occ = expand(
      master({
        exdate: [new Date('2026-01-13T15:00:00Z')], // skip the 13th
        rdate: [new Date('2026-01-09T15:00:00Z')], // add a Friday one-off
      }),
      [],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-31T00:00:00Z'),
    )
    const iso = occ.map((o) => o.startsAt.toISOString())
    expect(iso).not.toContain('2026-01-13T15:00:00.000Z')
    expect(iso).toContain('2026-01-09T15:00:00.000Z')
    // sorted by start
    expect(iso).toEqual([...iso].sort())
  })

  it('applies a single-occurrence override (moved time) keyed by original start', () => {
    const overrides: OverrideRow[] = [
      {
        id: 'ov1',
        originalStart: new Date('2026-01-13T15:00:00Z'),
        isCancelled: false,
        startsAt: new Date('2026-01-13T17:00:00Z'), // moved 9am → 11am
        title: 'Soccer (rescheduled)',
      },
    ]
    const occ = expand(master(), overrides, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-20T00:00:00Z'))
    const moved = occ.find((o) => o.originalStart.toISOString() === '2026-01-13T15:00:00.000Z')!
    expect(moved.startsAt.toISOString()).toBe('2026-01-13T17:00:00.000Z')
    expect(moved.title).toBe('Soccer (rescheduled)')
    expect(moved.overrideId).toBe('ov1')
  })

  it('removes a cancelled occurrence via an override', () => {
    const overrides: OverrideRow[] = [
      { id: 'ov2', originalStart: new Date('2026-01-20T15:00:00Z'), isCancelled: true },
    ]
    const occ = expand(master(), overrides, new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))
    expect(occ.map((o) => o.originalStart.toISOString())).not.toContain('2026-01-20T15:00:00.000Z')
    expect(occ).toHaveLength(3)
  })

  it('clamps to recurrence_end_at even for an open-ended rule', () => {
    const occ = expand(
      master({ recurrenceEndAt: new Date('2026-01-20T23:59:59Z') }),
      [],
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    )
    // Jan 6, 13, 20 only
    expect(occ).toHaveLength(3)
    expect(occ.at(-1)!.startsAt.toISOString()).toBe('2026-01-20T15:00:00.000Z')
  })

  it('an open-ended rule is bounded by the query window (no infinite loop)', () => {
    const occ = expand(master(), [], new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'))
    // ~52 Tuesdays in a year — finite, bounded by the window
    expect(occ.length).toBeGreaterThan(50)
    expect(occ.length).toBeLessThan(54)
  })
})
