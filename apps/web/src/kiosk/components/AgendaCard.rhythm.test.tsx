import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AgendaCard } from './AgendaCard'

// Today's agenda draws the same events the calendar does, so a rhythm booking has to
// read the same way in both places — otherwise the 🔁 mark looks like a calendar-screen
// quirk rather than something true about the event.
function mockToday(events: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: true, json: async () => ({ date: '', events }) }
  }) as unknown as typeof fetch
}

function noonToday(): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12).toISOString()
}

const base = {
  endsAt: null,
  allDay: false,
  location: null,
  personId: null,
  personName: null,
  personColor: null,
  personEmoji: null,
  participants: [],
}

function renderCard() {
  return render(
    <MemoryRouter>
      <AgendaCard />
    </MemoryRouter>
  )
}

describe('AgendaCard — rhythm marker', () => {
  it('marks a rhythm booking on today’s agenda', async () => {
    mockToday([{ ...base, id: 'r1', title: 'Temple visit', startsAt: noonToday(), rhythmId: 'rh-1' }])
    renderCard()
    await screen.findByText('Temple visit')
    expect(screen.getAllByTitle('Part of a rhythm').length).toBeGreaterThan(0)
  })

  it('leaves an ordinary event unmarked', async () => {
    mockToday([{ ...base, id: 'e1', title: 'Dentist', startsAt: noonToday() }])
    renderCard()
    await screen.findByText('Dentist')
    expect(screen.queryAllByTitle('Part of a rhythm')).toHaveLength(0)
  })
})
