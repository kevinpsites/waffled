import { render, screen, waitFor } from '@testing-library/react'
import { AgendaCard } from './AgendaCard'

// Build event ISO strings relative to the frozen "now" (see beforeEach).
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString()

function mockEvents(events: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: true, json: async () => ({ date: '2026-06-08', events }) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  // Anchor "now" to a stable mid-afternoon so a "1h ago" end doesn't wander onto a
  // different day near midnight (a real CI flake). Fake ONLY Date so findBy timers work.
  const base = new Date()
  base.setHours(14, 0, 0, 0)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AgendaCard past-event fading', () => {
  it('fades a today event that has already ended, not an upcoming or all-day one (big-card layout)', async () => {
    // ≤3 events → the roomy .agenda-bigcard layout.
    mockEvents([
      { id: 'past', title: 'Morning standup', startsAt: iso(-120), endsAt: iso(-60), allDay: false },
      { id: 'future', title: 'Evening walk', startsAt: iso(120), endsAt: iso(180), allDay: false },
      { id: 'allday', title: 'Trash day', startsAt: iso(-120), endsAt: null, allDay: true },
    ])
    render(<AgendaCard />)
    const past = (await screen.findByText('Morning standup')).closest('.agenda-bigcard')
    const future = (await screen.findByText('Evening walk')).closest('.agenda-bigcard')
    const allday = (await screen.findByText('Trash day')).closest('.agenda-bigcard')
    await waitFor(() => expect(past).toHaveClass('past'))
    expect(future).not.toHaveClass('past')
    expect(allday).not.toHaveClass('past')
  })

  it('fades a past event in the compact row layout (>3 events)', async () => {
    mockEvents([
      { id: 'past', title: 'Morning standup', startsAt: iso(-120), endsAt: iso(-60), allDay: false },
      { id: 'future', title: 'Evening walk', startsAt: iso(120), endsAt: iso(180), allDay: false },
      { id: 'e3', title: 'Piano', startsAt: iso(200), endsAt: iso(260), allDay: false },
      { id: 'e4', title: 'Dinner', startsAt: iso(300), endsAt: iso(360), allDay: false },
    ])
    render(<AgendaCard />)
    const past = (await screen.findByText('Morning standup')).closest('.agenda-row')
    const future = (await screen.findByText('Evening walk')).closest('.agenda-row')
    await waitFor(() => expect(past).toHaveClass('past'))
    expect(future).not.toHaveClass('past')
  })
})
