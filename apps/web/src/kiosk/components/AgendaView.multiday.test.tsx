import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AgendaView } from './AgendaView'

// Device timezone so localDate() buckets events the way the view's todayKey (ymd of new Date()) does.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// Local midnight `offset` days from the frozen "today".
function dayStart(offset: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  return d.toISOString()
}

beforeEach(() => {
  // A stable mid-afternoon today, as in AgendaView.past.test.tsx; fake only Date.
  const base = new Date()
  base.setHours(14, 0, 0, 0)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AgendaView multi-day events', () => {
  it('lists a trip already under way under each of its days from today on', async () => {
    // Started yesterday; the end is exclusive, so it covers yesterday, today, tomorrow and the day after.
    const events = [
      { id: 'lake', seriesId: null, occurrenceStart: null, title: 'Lake week', allDay: true,
        startsAt: dayStart(-1), endsAt: dayStart(3), personColor: null, participants: [] },
    ] as unknown as Parameters<typeof AgendaView>[0]['events']

    const { container } = render(
      <MemoryRouter>
        <AgendaView events={events} tz={TZ} onOpenEvent={() => {}} onPickDate={() => {}} onCreate={() => {}} />
      </MemoryRouter>
    )
    expect(await screen.findAllByText('Lake week')).toHaveLength(3)
    const headers = [...container.querySelectorAll('.ag-group-h .wf-serif')].map((n) => n.textContent)
    expect(headers.slice(0, 2)).toEqual(['Today', 'Tomorrow'])
    expect(headers).toHaveLength(3)
  })
})
