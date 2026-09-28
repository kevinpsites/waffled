import type { AgendaEvent } from '../../lib/api'
import { eventDayKeys, eventsByDay, weekSpans } from './month-spans'

function ev(id: string, startsAt: string, endsAt: string | null, allDay: boolean): AgendaEvent {
  return {
    id, title: id, startsAt, endsAt, allDay, location: null, personId: null,
    personName: null, personColor: null, personEmoji: null, participants: [],
  } as AgendaEvent
}
// All-day ends are exclusive — the day after the last day, Google's shape.
const trip = (id: string, first: string, endExclusive: string) =>
  ev(id, `${first}T00:00:00Z`, `${endExclusive}T00:00:00Z`, true)

const week = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']

describe('eventDayKeys', () => {
  it('spreads an all-day event up to, not including, its end day', () => {
    expect(eventDayKeys(trip('t', '2026-09-15', '2026-09-18'), 'UTC')).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
  })

  it('keeps timed, one-day and open-ended events on their start day', () => {
    expect(eventDayKeys(ev('d', '2026-09-15T18:00:00Z', '2026-09-16T02:00:00Z', false), 'UTC')).toEqual(['2026-09-15'])
    expect(eventDayKeys(trip('b', '2026-09-15', '2026-09-16'), 'UTC')).toEqual(['2026-09-15'])
    expect(eventDayKeys(ev('o', '2026-09-15T00:00:00Z', null, true), 'UTC')).toEqual(['2026-09-15'])
  })

  it('caps a corrupt far-future end at a year', () => {
    expect(eventDayKeys(trip('x', '2026-01-01', '2099-01-01'), 'UTC')).toHaveLength(366)
  })

  it('files a trip under each day it covers', () => {
    const byDay = eventsByDay([trip('t', '2026-09-15', '2026-09-17')], 'UTC')
    expect(Object.keys(byDay).sort()).toEqual(['2026-09-15', '2026-09-16'])
  })
})

describe('weekSpans', () => {
  it('draws a trip as one bar across its days and leaves their chips', () => {
    const t = trip('hamptons', '2026-09-15', '2026-09-18')
    const dinner = ev('dinner', '2026-09-16T18:00:00Z', null, false)
    const spans = weekSpans(week, eventsByDay([t, dinner], 'UTC'), 'UTC', 3)
    expect(spans.bars.map((b) => [b.event.id, b.startCol, b.endCol, b.lane])).toEqual([['hamptons', 2, 4, 0]])
    expect(spans.lanes).toBe(1)
    expect(spans.chipsByDay['2026-09-16'].map((e) => e.id)).toEqual(['dinner'])
    expect(spans.chipsByDay['2026-09-15']).toEqual([])
  })

  it('cuts a trip at the row edge and says it continues', () => {
    const bar = weekSpans(week, eventsByDay([trip('camping', '2026-09-18', '2026-09-23')], 'UTC'), 'UTC', 3).bars[0]
    expect([bar.startCol, bar.endCol, bar.continuesBefore, bar.continuesAfter]).toEqual([5, 6, false, true])
  })

  it('does not say a trip ending on the last day of the row continues', () => {
    const bar = weekSpans(week, eventsByDay([trip('end', '2026-09-17', '2026-09-20')], 'UTC'), 'UTC', 3).bars[0]
    expect(bar.continuesAfter).toBe(false)
  })

  it('puts overlapping trips in separate lanes and reuses a free one', () => {
    const spans = weekSpans(
      week,
      eventsByDay([trip('a', '2026-09-14', '2026-09-17'), trip('b', '2026-09-15', '2026-09-19'), trip('c', '2026-09-17', '2026-09-20')], 'UTC'),
      'UTC',
      3,
    )
    expect(Object.fromEntries(spans.bars.map((b) => [b.event.id, b.lane]))).toEqual({ a: 0, b: 1, c: 0 })
    expect(spans.lanes).toBe(2)
  })

  it('keeps one-day events as chips', () => {
    const spans = weekSpans(week, eventsByDay([trip('birthday', '2026-09-16', '2026-09-17')], 'UTC'), 'UTC', 3)
    expect(spans.bars).toEqual([])
    expect(spans.chipsByDay['2026-09-16'].map((e) => e.id)).toEqual(['birthday'])
  })

  it('falls back to chips past the lane cap', () => {
    const trips = ['a', 'b', 'c'].map((id) => trip(id, '2026-09-14', '2026-09-16'))
    const spans = weekSpans(week, eventsByDay(trips, 'UTC'), 'UTC')
    expect(spans.bars.map((b) => b.event.id)).toEqual(['a', 'b'])
    expect(spans.chipsByDay['2026-09-14'].map((e) => e.id)).toEqual(['c'])
  })
})
