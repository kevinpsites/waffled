import { render, screen, waitFor } from '@testing-library/react'
import { ApprovalsBar } from './Approvals'

const ok = (body: unknown) => ({ ok: true, json: async () => body })

// Drive ApprovalsBar's data: an awaiting chore + the caller's capabilities. The bar
// shows a "to approve" entry only for queues the caller can actually act on.
function mockApi(capabilities: string[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/household'))
      return ok({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { id: 'me', name: 'Me', memberType: 'adult', isAdmin: false, capabilities } })
    if (u.includes('/api/chore-instances/awaiting'))
      return ok({ instances: [{ id: 'a1', choreId: 'c1', choreTitle: 'Wash car', emoji: '🚗', personId: 'p1', personName: 'Wally', status: 'awaiting', rewardAmount: 5, dueOn: '2026-06-24' }] })
    if (u.includes('/api/redemptions')) return ok({ redemptions: [] })
    if (u.includes('/api/currencies')) return ok({ currencies: [] })
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('ApprovalsBar capability gating', () => {
  it('hides the chore-approval bar when the caller lacks chore.approve', async () => {
    mockApi([])
    render(<ApprovalsBar />)
    // Give the queue a chance to load; the bar must stay absent.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.queryByText(/to approve/)).not.toBeInTheDocument()
  })

  it('shows the chore-approval bar when the caller has chore.approve', async () => {
    mockApi(['chore.approve'])
    render(<ApprovalsBar />)
    expect(await screen.findByText(/chore to approve/)).toBeInTheDocument()
  })
})
