import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalCreate } from './GoalCreate'

// A self-only list (Wally) and a shared group (Wally + Lottie). Without
// goal.manage only the self-only list is a valid target.
const lists = [
  {
    id: 'l-wally', name: 'Wally', emoji: '🐢', colorHex: '#25A368', isPrivate: false, sortOrder: 0,
    members: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }], goalCount: 0,
  },
  {
    id: 'l-kids', name: 'Kids', emoji: '🧒', colorHex: '#888888', isPrivate: false, sortOrder: 1,
    members: [
      { personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' },
      { personId: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B' },
    ],
    goalCount: 0,
  },
]

// A shared goal (two participants → nobody's sole-participant goal).
const sharedGoal = {
  id: 'g1', goalListId: 'l-kids', title: '1,000 Hours Outside', emoji: '🌲', category: 'physical',
  goalType: 'total', unit: 'hours', habitPeriod: null, habitTargetPerPeriod: null, trackingMode: 'shared_total',
  autoFromCalendar: false, deadline: null, isFeatured: true, hasRewards: false, target: 1000,
  participants: [
    { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 102 },
    { personId: 'p2', name: 'Lottie', colorHex: '#E0794B', avatarEmoji: '🦊', target: 1000, progress: 78 },
  ],
  milestones: [], steps: [],
}
// Same goal but solely Wally's.
const soloGoal = { ...sharedGoal, goalListId: 'l-wally', participants: [sharedGoal.participants[0]] }

const me = (capabilities: string[]) => ({ id: 'p1', name: 'Wally', memberType: 'kid', isAdmin: false, capabilities })

function mockApi(person: unknown, goal: unknown = sharedGoal) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists }) }
    if (u.includes('/api/goals/g1')) return { ok: true, json: async () => ({ goal }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/goals/new" element={<GoalCreate />} />
        <Route path="/goals/:id" element={<div>goal detail sentinel</div>} />
        <Route path="/goals/:id/edit" element={<GoalCreate />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('GoalCreate capability gating', () => {
  it('hides shared-group targets from a user without goal.manage', async () => {
    mockApi(me([]))
    renderAt('/goals/new?list=l-kids')
    // The self-only list is offered…
    expect(await screen.findByRole('button', { name: /Wally/ })).toBeInTheDocument()
    // …but the shared "Kids" group is not a pickable target.
    expect(screen.queryByRole('button', { name: /Kids/ })).not.toBeInTheDocument()
  })

  it('offers shared-group targets to a goal.manage holder', async () => {
    mockApi(me(['goal.manage']))
    renderAt('/goals/new?list=l-kids')
    expect(await screen.findByRole('button', { name: /Wally/ })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Kids/ })).toBeInTheDocument()
  })

  it('bounces a kid off the edit form for a shared goal (deep link)', async () => {
    mockApi(me([]), sharedGoal)
    renderAt('/goals/g1/edit')
    expect(await screen.findByText('goal detail sentinel')).toBeInTheDocument()
  })

  it('lets a kid edit their own sole-participant goal', async () => {
    mockApi(me([]), soloGoal)
    renderAt('/goals/g1/edit')
    // Stays on the edit form (no redirect) — the name field is present.
    expect(await screen.findByText('Name your goal')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('goal detail sentinel')).not.toBeInTheDocument())
  })
})
