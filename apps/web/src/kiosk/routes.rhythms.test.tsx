import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskRoutes } from './routes'

// The Today card links to /rhythms, so the route has to exist — and, like every
// other optional-module page, a direct URL must redirect rather than render a
// screen whose endpoints 403.

function mockHousehold(modules: Record<string, boolean>) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
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
    if (u.includes('/api/today-layout')) {
      return { ok: true, json: async () => ({ resolved: { cols: [[], [], []], hidden: [] }, family: null, user: null, source: 'default', cards: [], canEditFamily: false }) }
    }
    return { ok: true, json: async () => ({ rhythms: [], items: [], persons: [], events: [], countdowns: [], people: [], instances: [], entries: [], lists: [], goals: [], photos: [], recipes: [] }) }
  }) as unknown as typeof fetch
}

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><KioskRoutes /></MemoryRouter>)
}

describe('/rhythms', () => {
  it('renders the register when the module is on', async () => {
    mockHousehold({ rhythms: true })
    renderAt('/rhythms')
    expect(await screen.findByRole('button', { name: /new rhythm/i })).toBeInTheDocument()
  })

  it('redirects away when the module is off', async () => {
    mockHousehold({ rhythms: false })
    renderAt('/rhythms')
    await waitFor(() => expect(screen.queryByRole('button', { name: /new rhythm/i })).toBeNull())
    // The rail entry goes with it.
    expect(screen.queryByRole('link', { name: /rhythms/i })).toBeNull()
  })
})
