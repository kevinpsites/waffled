import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Calendar } from './Calendar'
import { TopbarSlotProvider } from './topbar-slot'

// The calendar grids were cut on Sunday no matter what the household's "week starts
// on" said. The subtle part isn't the header row — it's that the month grid's first
// day is computed TWICE, once for the events fetch window and once for the rendered
// 42-day grid. Move one without the other and the last row of the grid sits outside
// the range that was fetched, so its events silently vanish.

const asked: string[] = []

function mockApi(weekStart: 'sunday' | 'monday') {
  asked.length = 0
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          household: { id: 'h1', name: 'Home', weekStart, timezone: 'America/Chicago' },
          person: null, memberships: [], pendingInvites: [],
        }),
      }
    }
    if (u.includes('/api/events')) {
      asked.push(u)
      return { ok: true, json: async () => ({ from: '', to: '', events: [] }) }
    }
    return { ok: true, json: async () => ({ persons: [], countdowns: [], events: [] }) }
  }) as unknown as typeof fetch
}

function renderCalendar() {
  return render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <Calendar />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

const dow = () => Array.from(document.querySelectorAll('.cal-dow > div')).map((el) => el.textContent?.trim() ?? '')

// The day the month grid should start on: the household's first day, on or before
// the 1st of the shown month.
function expectedGridStart(firstDay: number): string {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const back = (first.getDay() - firstDay + 7) % 7
  const d = new Date(now.getFullYear(), now.getMonth(), 1 - back)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('Calendar — the household decides which day starts the week', () => {
  it('leads the month grid with Monday for a monday household', async () => {
    mockApi('monday')
    renderCalendar()
    await waitFor(() => expect(dow()[0]).toBe('Mon'))
    expect(dow().slice(0, 7)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('still leads with Sunday for a sunday household', async () => {
    mockApi('sunday')
    renderCalendar()
    await waitFor(() => expect(dow()[0]).toBe('Sun'))
    expect(dow().slice(0, 7)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  })

  it('fetches the same 42 days it renders (monday)', async () => {
    // The regression this guards: a Monday-led grid with a Sunday-cut fetch window
    // is off by one day, so the grid's final row has no events.
    mockApi('monday')
    renderCalendar()
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))
    await waitFor(() => expect(asked.some((u) => u.includes(expectedGridStart(1)))).toBe(true))
  })

  it('fetches the same 42 days it renders (sunday)', async () => {
    mockApi('sunday')
    renderCalendar()
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))
    await waitFor(() => expect(asked.some((u) => u.includes(expectedGridStart(0)))).toBe(true))
  })
})
