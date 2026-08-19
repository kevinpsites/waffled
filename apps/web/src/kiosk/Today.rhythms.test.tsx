import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Today } from './Today'

// `rhythms` is an optional module and OFF by default. Without the gate, every
// household that never asked for it would fetch and render the card — which is the
// same mistake the pantry/goals cards already guard against.

const temple = {
  id: 'r-temple',
  title: 'Temple visit',
  emoji: '🛕',
  notes: null,
  personId: null,
  satisfiedBy: 'scheduling' as const,
  every: '3 mons',
  startsOn: '2026-07-01',
  autoSchedule: false,
  rrule: null,
  leadTime: '14 days',
  lastCompletedAt: null,
  nextDueAt: null,
  isActive: true,
}

function mockHousehold(modules: Record<string, boolean>) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/today-layout')) {
      return { ok: true, json: async () => ({ resolved: { cols: [[], [], []], hidden: [] }, family: null, user: null, source: 'default', cards: [], canEditFamily: false }) }
    }
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday', settings: { modules } },
          person: { id: 'me', name: 'Kevin', memberType: 'adult', isAdmin: true, capabilities: [] },
        }),
      }
    }
    if (u.includes('/api/rhythms/attention')) {
      return { ok: true, json: async () => ({ items: [{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }] }) }
    }
    return { ok: true, json: async () => ({ persons: [], items: [], lists: [], people: [], instances: [], entries: [], events: [], goals: [], photos: [], recipes: [], countdowns: [] }) }
  }) as unknown as typeof fetch
}

function renderToday() {
  return render(<MemoryRouter><Today /></MemoryRouter>)
}

describe('Today — the rhythms card is gated on the module', () => {
  it('shows the card when the module is on', async () => {
    mockHousehold({ rhythms: true })
    renderToday()
    expect(await screen.findByText('Temple visit')).toBeInTheDocument()
  })

  it('renders nothing — and asks nothing of the server — when the module is off', async () => {
    mockHousehold({ rhythms: false })
    renderToday()
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    expect(screen.queryByText('Temple visit')).toBeNull()
    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some((c) => String(c[0]).includes('/api/rhythms'))
    expect(asked).toBe(false)
  })
})
