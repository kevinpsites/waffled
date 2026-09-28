import { render } from '@testing-library/react'
import { DayView } from './DayView'
import type { AgendaEvent } from '../../lib/api'

// Device timezone, so the view's local day (ymd) and localDate() agree.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const local = (s: string) => new Date(s).toISOString()

function ev(id: string, title: string, startsAt: string, endsAt: string | null, allDay: boolean): AgendaEvent {
  return {
    id, title, startsAt, endsAt, allDay,
    location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [],
  } as AgendaEvent
}

// All-day ends are exclusive: the trip covers Sep 15, 16 and 17.
const trip = ev('trip', 'Trip to the Hamptons', local('2026-09-15T00:00'), local('2026-09-18T00:00'), true)
const dentist = ev('dentist', 'Dentist', local('2026-09-15T09:00'), local('2026-09-15T10:00'), false)

function allDayTitles(day: string) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ persons: [] }) })) as unknown as typeof fetch
  const { container, unmount } = render(
    <DayView day={new Date(`${day}T00:00:00`)} events={[trip, dentist]} tz={TZ} onOpenEvent={() => {}} onCreate={() => {}} />
  )
  const titles = [...container.querySelectorAll('.dv-allday-ev')].map((n) => n.textContent)
  const timed = [...container.querySelectorAll('.dv-ev-title')].map((n) => n.textContent)
  unmount()
  return { titles, timed }
}

describe('DayView multi-day events', () => {
  it('lists a trip in the all-day strip on every day it covers', () => {
    expect(allDayTitles('2026-09-15').titles).toEqual(['Trip to the Hamptons'])
    expect(allDayTitles('2026-09-16').titles).toEqual(['Trip to the Hamptons'])
    expect(allDayTitles('2026-09-17').titles).toEqual(['Trip to the Hamptons'])
  })

  it('drops it on its exclusive end day, and keeps a timed event on its own day', () => {
    expect(allDayTitles('2026-09-18').titles).toEqual([])
    expect(allDayTitles('2026-09-15').timed).toEqual(['Dentist'])
    expect(allDayTitles('2026-09-16').timed).toEqual([])
  })
})
