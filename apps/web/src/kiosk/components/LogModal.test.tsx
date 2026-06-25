import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LogModal } from './LogModal'

// A shared, divisible (total) goal with two participants — so the "who took part"
// multi-select normally appears.
const goal = {
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
  totalProgress: 100,
  milestoneTotal: 0,
  milestoneReached: 0,
  periodDone: 0,
  stepTotal: 0,
  stepDone: 0,
  streakDays: 0,
  loggedTodayBy: [],
  participants: [
    { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 60 },
    { personId: 'p2', name: 'Lottie', colorHex: '#E0653F', avatarEmoji: '🦊', target: 1000, progress: 40 },
  ],
}

function mockApi(logged: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (/\/api\/goals\/[^/]+\/log$/.test(u) && init?.method === 'POST') {
      logged.push(JSON.parse(init.body!))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (/\/api\/goals\/[^/]+$/.test(u) && init?.method === 'DELETE') {
      return { ok: true, status: 204, json: async () => ({}) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('LogModal capability gating', () => {
  it('canLogOthers=false restricts the "who" picker to self and logs for self only', async () => {
    const logged: unknown[] = []
    mockApi(logged)
    render(<LogModal goal={goal} canLogOthers={false} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    // The restricted user is attributed to themselves — the other participant is
    // never offered, so no cross-person picker option appears.
    expect(await screen.findByText('Log progress')).toBeInTheDocument()
    expect(screen.queryByText('Lottie')).not.toBeInTheDocument()
    // Logging credits self (p1) — never the other person.
    fireEvent.click(screen.getByRole('button', { name: /^Log \d/ }))
    await waitFor(() => expect(logged).toHaveLength(1))
    expect(logged[0]).toMatchObject({ personIds: ['p1'] })
  })

  it('canLogOthers=true shows the full who-took-part picker', async () => {
    mockApi([])
    render(<LogModal goal={goal} canLogOthers={true} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument()
  })

  it('canDelete=false hides the inline Delete goal affordance', async () => {
    mockApi([])
    render(<LogModal goal={goal} canLogOthers={false} canDelete={false} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByText('Log progress')).toBeInTheDocument()
    expect(screen.queryByText(/Delete goal/)).not.toBeInTheDocument()
  })

  it('canDelete=true shows the Delete goal affordance', async () => {
    mockApi([])
    render(<LogModal goal={goal} canDelete={true} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByText('Delete goal')).toBeInTheDocument()
  })
})
