import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalDetail } from './GoalDetail'

// A shared goal with two participants (so it isn't anyone's sole-participant goal).
const sharedGoal = {
  id: 'g1',
  goalListId: 'l1',
  title: '1,000 Hours Outside',
  emoji: '🌲',
  category: 'physical',
  goalType: 'total',
  unit: 'hours',
  habitPeriod: null,
  habitTargetPerPeriod: null,
  trackingMode: 'shared_total',
  logMethod: 'quick_log',
  autoFromCalendar: false,
  deadline: null,
  isFeatured: true,
  hasRewards: false,
  target: 1000,
  totalProgress: 312,
  milestoneTotal: 0,
  milestoneReached: 0,
  periodDone: 0,
  stepTotal: 0,
  stepDone: 0,
  streakDays: 0,
  createdAt: '2026-01-01T00:00:00Z',
  participants: [
    { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 102 },
    { personId: 'p2', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: '🐻', target: 1000, progress: 78 },
  ],
  milestones: [],
  steps: [],
  recent: [],
  thisWeek: 14.5,
}

// Same goal but owned solely by p1 — a restricted user's own goal.
const soloGoal = {
  ...sharedGoal,
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 102 }],
}

const me = (capabilities: string[], isAdmin = false) => ({ id: 'p1', name: 'Wally', memberType: 'kid', isAdmin, capabilities })

function mockApi(goal: unknown, person: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    // Checked first — its URL also contains "/api/goals/g1".
    if (u.includes('/activity')) return { ok: true, json: async () => ({ startDate: '2026-01-01', endDate: null, today: '2026-07-17', days: [] }) }
    if (u.includes('/api/goals/g1')) return { ok: true, json: async () => ({ goal }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/goals/g1']}>
      <Routes>
        <Route path="/goals/:id" element={<GoalDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

// NOTE: the "Edit goal" button is injected into the topbar via useTopbarFull (a
// context consumed by the layout's Topbar), so it isn't in this isolated DOM. The
// body-level "Delete goal" affordance is gated by the same `canEdit` flag, so we
// assert on it as the observable proxy for the edit/delete gate.
describe('GoalDetail capability gating', () => {
  it('hides Delete on a shared goal for a user without goal.manage', async () => {
    mockApi(sharedGoal, me([]))
    renderDetail()
    expect(await screen.findByText('1,000 Hours Outside')).toBeInTheDocument()
    // Let the household fetch resolve so `person` (no caps) is in state, then
    // confirm the delete affordance never appears for this shared goal.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/household'), expect.anything()))
    expect(screen.queryByText(/Delete goal/)).not.toBeInTheDocument()
  })

  it('shows Delete on a shared goal for a user with goal.manage', async () => {
    mockApi(sharedGoal, me(['goal.manage']))
    renderDetail()
    expect(await screen.findByText('Delete goal')).toBeInTheDocument()
  })

  it('shows Delete on the user’s own sole-participant goal without goal.manage', async () => {
    mockApi(soloGoal, me([]))
    renderDetail()
    expect(await screen.findByText('Delete goal')).toBeInTheDocument()
  })
})
