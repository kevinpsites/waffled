import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Settings } from './Settings'

const household = { id: 'A', name: 'A', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }
const person = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED' }
const memberships = [
  { householdId: 'A', householdName: 'A', personId: 'p1', isAdmin: true, memberType: 'adult' },
  { householdId: 'B', householdName: 'B', personId: 'p2', isAdmin: false, memberType: 'adult' },
]
const pendingInvites = [{ id: 'inv1', householdId: 'C', householdName: 'C', memberType: 'adult', isAdmin: false }]

// Capture POST bodies by path so the test can assert what was sent.
type Sent = { path: string; body: unknown }

function mockApi(sent: Sent[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') {
      sent.push({ path: u, body: init.body ? JSON.parse(String(init.body)) : undefined })
      if (u.includes('/api/auth/switch')) return { ok: true, json: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900, householdId: 'B', memberships }) }
      if (u.includes('/accept')) return { ok: true, json: async () => ({ membership: memberships[1] }) }
    }
    if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members: [] }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person, memberships, pendingInvites }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const renderHouseholds = () =>
  render(
    <MemoryRouter initialEntries={['/settings?tab=households']}>
      <Settings />
    </MemoryRouter>,
  )

describe('Households panel', () => {
  it('renders the nav tab, a Switch for another household, and an Accept for an invite', async () => {
    mockApi([])
    renderHouseholds()
    // nav item present
    expect(await screen.findByText('Households', { selector: '.set-navitem' })).toBeInTheDocument()
    // B is switchable; C invite is acceptable
    expect(await screen.findByText('Switch')).toBeInTheDocument()
    expect(screen.getByText('Accept')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('switches household: POSTs /api/auth/switch and navigates home', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true })

    renderHouseholds()
    fireEvent.click(await screen.findByText('Switch'))

    await waitFor(() => expect(sent.some((s) => s.path.includes('/api/auth/switch'))).toBe(true))
    const call = sent.find((s) => s.path.includes('/api/auth/switch'))!
    expect(call.body).toEqual({ householdId: 'B' })
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
  })

  it('accepts an invite: POSTs /api/auth/invites/:id/accept', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    renderHouseholds()
    fireEvent.click(await screen.findByText('Accept'))
    await waitFor(() => expect(sent.some((s) => s.path.includes('/api/auth/invites/inv1/accept'))).toBe(true))
  })
})
