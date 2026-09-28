import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { PersonProfile } from './PersonProfile'

// "This week's one thing", surfaced on the profile: a child's Kids-step answer lived only in
// `planning_session_steps.data.kids`, so they never saw it again. The card is PRESENCE-GATED —
// the server sends null when the module is off, when no session covers the week, or when nobody
// answered — so it isn't rendered rather than explaining itself.

const base = {
  person: { id: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B', age: 7, memberType: 'kid' },
  activeGoals: 0, topStreak: 0, stars: 0,
  currencies: [], balances: [], goals: [], categoryBalance: [],
  insight: { lean: [], light: [], suggestions: [], text: '' },
  recentLedger: [], redemptions: [], rewardShop: [], savingToward: null,
  streak: { days: 0, week: [] },
  planningFocus: null as null | { emoji: string; label: string; detail: string | null; weekStart: string },
}

const me = { id: 'p9', name: 'Kevin', memberType: 'adult', isAdmin: true, capabilities: ['goal.manage'] }

function mockApi(overview: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons/p2/overview')) return { ok: true, json: async () => overview }
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists: [] }) }
    if (u.includes('/api/conversions')) return { ok: true, json: async () => ({ conversions: [] }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [me, base.person] }) }
    if (u.includes('/api/household')) {
      return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: me }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const renderProfile = () =>
  render(
    <MemoryRouter initialEntries={['/person/p2']}>
      <Routes>
        <Route path="/person/:id" element={<PersonProfile />} />
      </Routes>
    </MemoryRouter>
  )

describe('PersonProfile · this week’s one thing', () => {
  it('shows what they said, in their own words, and where it came from', async () => {
    mockApi({
      ...base,
      planningFocus: { emoji: '📚', label: 'Read 20 minutes a day', detail: '3 of 20 books', weekStart: '2026-09-06' },
    })
    renderProfile()

    expect(await screen.findByText('Read 20 minutes a day')).toBeInTheDocument()
    expect(screen.getByText('3 of 20 books')).toBeInTheDocument()
    expect(screen.getByText(/said at this week’s planning session/i)).toBeInTheDocument()
  })

  it('renders no card at all when there is nothing to say', async () => {
    // Module off, no session for this week, or nobody answered — the server collapses all three
    // to null, and an absent card is the whole affordance.
    mockApi({ ...base, planningFocus: null })
    renderProfile()
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/overview'), expect.anything()))
    expect(screen.queryByText(/this week’s one thing/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/said at this week’s planning session/i)).not.toBeInTheDocument()
  })

  it('survives a focus with no detail line', async () => {
    mockApi({ ...base, planningFocus: { emoji: '✨', label: 'Be kind to Wally', detail: null, weekStart: '2026-09-06' } })
    renderProfile()
    expect(await screen.findByText('Be kind to Wally')).toBeInTheDocument()
    expect(screen.getByText(/said at this week’s planning session/i)).toBeInTheDocument()
  })
})
