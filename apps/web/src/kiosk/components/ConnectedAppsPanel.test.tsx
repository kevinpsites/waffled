import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConnectedAppsPanel } from './ConnectedAppsPanel'

const GRANTS = [
  {
    id: 'g1',
    clientId: 'wfc_1',
    clientName: 'Claude',
    redirectHost: 'claude.ai',
    scopes: ['family:read', 'calendar:write'],
    householdId: 'h1',
    householdName: 'Sites',
    createdAt: '2026-11-01T10:00:00Z',
    lastUsedAt: '2026-11-12T10:00:00Z',
  },
  {
    id: 'g2',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    redirectHost: 'localhost:53682',
    scopes: ['lists:read'],
    householdId: 'h1',
    householdName: 'Sites',
    createdAt: '2026-11-02T10:00:00Z',
    lastUsedAt: null,
  },
]

const DESCRIPTIONS = {
  'family:read': 'See your household and its members',
  'calendar:write': 'Add, move and cancel calendar events',
  'lists:read': 'See the grocery list and your other lists',
}

let deleted: string[] = []
function mockFetch(grants = GRANTS) {
  deleted = []
  let current = [...grants]
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const ok = (body: unknown, status = 200) => ({ ok: true, status, headers: { get: () => 'application/json' }, json: async () => body })
    if (u === '/api/oauth/grants') return ok({ grants: current, scopeDescriptions: DESCRIPTIONS })
    const m = /^\/api\/oauth\/grants\/(.+)$/.exec(u)
    if (m && init?.method === 'DELETE') {
      deleted.push(m[1])
      current = current.filter((g) => g.id !== m[1])
      return ok(undefined, 204)
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Settings → Connected apps', () => {
  it('lists each connection with its app, where it returns to, and what it may do', async () => {
    mockFetch()
    render(<ConnectedAppsPanel />)
    const claude = (await screen.findByText('Claude')).closest('.apikey-row') as HTMLElement
    expect(within(claude).getByText(/claude\.ai/)).toBeInTheDocument()
    expect(within(claude).getByText(/See your household and its members/)).toBeInTheDocument()
    expect(within(claude).getByText(/Add, move and cancel calendar events/)).toBeInTheDocument()
    expect(within(claude).getByText(/Last used/)).toBeInTheDocument()
    const code = screen.getByText('Claude Code').closest('.apikey-row') as HTMLElement
    expect(within(code).getByText(/Never used/)).toBeInTheDocument()
  })

  it('revokes after a confirm', async () => {
    mockFetch()
    render(<ConnectedAppsPanel />)
    const claude = (await screen.findByText('Claude')).closest('.apikey-row') as HTMLElement
    fireEvent.click(within(claude).getByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/Disconnect “Claude”\?/)).toBeInTheDocument()
    expect(deleted).toEqual([])
    const dialog = screen.getByText(/Disconnect “Claude”\?/).closest('form') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(deleted).toEqual(['g1']))
    await waitFor(() => expect(screen.queryByText('Claude')).not.toBeInTheDocument())
  })

  it('says so when nothing is connected', async () => {
    mockFetch([])
    render(<ConnectedAppsPanel />)
    expect(await screen.findByText(/No apps are connected/)).toBeInTheDocument()
  })
})
