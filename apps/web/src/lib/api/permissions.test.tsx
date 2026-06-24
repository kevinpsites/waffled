import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Settings } from '../../kiosk/Settings'

const ok = (body: unknown) => ({ ok: true, json: async () => body })

// Seed the Settings page as an admin so the Family & People tab (which hosts the
// Permissions grid) renders, then drive /api/permissions for the grid itself.
function mockApi(onPut: (body: unknown) => void) {
  const matrix = {
    adult: { 'chore.manage': true, 'chore.approve': true, 'reward.manage': true, 'reward.approve': true },
    teen: { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false },
    kid: { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false },
  }
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const m = init?.method ?? 'GET'
    if (u.includes('/api/household/settings')) return ok({ household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday', location: null, ownerPersonId: null }, members: [] })
    if (u.includes('/api/household')) return ok({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { id: 'me', name: 'Me', memberType: 'adult', isAdmin: true, capabilities: [] } })
    if (u.includes('/api/permissions') && m === 'GET') return ok({ permissions: matrix, capabilities: Object.keys(matrix.adult), roles: ['adult', 'teen', 'kid'] })
    if (u.includes('/api/permissions') && m === 'PUT') {
      const body = JSON.parse(init!.body!)
      onPut(body)
      return ok({ permissions: { ...matrix, ...body.permissions } })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Permissions grid', () => {
  it('renders the role rows + capability columns', async () => {
    mockApi(() => {})
    render(<MemoryRouter><Settings /></MemoryRouter>)
    expect(await screen.findByText('Permissions')).toBeInTheDocument()
    // Column headers (capabilities) + role rows (grid loads async).
    expect(await screen.findByText('Manage chores')).toBeInTheDocument()
    expect(screen.getByText('Approve redemptions')).toBeInTheDocument()
    expect(screen.getByText('Teen')).toBeInTheDocument()
    expect(screen.getByText('Kid')).toBeInTheDocument()
  })

  it('toggling a cell PUTs the updated matrix', async () => {
    let put: unknown = null
    mockApi((b) => { put = b })
    render(<MemoryRouter><Settings /></MemoryRouter>)
    const cell = await screen.findByLabelText('Teen: Manage chores')
    fireEvent.click(cell)
    await waitFor(() => expect(put).not.toBeNull())
    expect(put).toMatchObject({ permissions: { teen: { 'chore.manage': true } } })
  })
})
