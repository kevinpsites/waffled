import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { PersonProfile } from './PersonProfile'

// Lottie (p2) — a sibling. The profile header's "New goal for Lottie" button is
// injected via useTopbarFull, so it's not in this isolated DOM; the body-level
// "gentle idea" suggestion link is gated by the same flag, so we assert on it as
// the observable proxy for the create-for-this-person gate.
const overview = {
  person: { id: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B', age: 7, memberType: 'kid' },
  activeGoals: 1, topStreak: 0, stars: 0,
  currencies: [], balances: [], goals: [], categoryBalance: [],
  insight: { lean: [], light: [], suggestions: ['Read 20 books'], text: 'Lottie is on a roll.' },
  recentLedger: [], redemptions: [], rewardShop: [], savingToward: null,
  streak: { days: 0, week: [] },
}

const lists = [
  { id: 'l-wally', name: 'Wally', emoji: '🐢', colorHex: '#25A368', isPrivate: false, sortOrder: 0, members: [{ personId: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' }], goalCount: 0 },
  { id: 'l-lottie', name: 'Lottie', emoji: '🦊', colorHex: '#E0794B', isPrivate: false, sortOrder: 1, members: [{ personId: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B' }], goalCount: 0 },
]

const me = (id: string, capabilities: string[]) => ({ id, name: id === 'p1' ? 'Wally' : 'Kevin', memberType: id === 'p1' ? 'kid' : 'adult', isAdmin: false, capabilities })

function mockApi(person: unknown) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons/p2/overview')) return { ok: true, json: async () => overview }
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists }) }
    if (u.includes('/api/conversions')) return { ok: true, json: async () => ({ conversions: [] }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [me('p1', []), overview.person] }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={['/person/p2']}>
      <Routes>
        <Route path="/person/:id" element={<PersonProfile />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('PersonProfile create-for-this-person gating', () => {
  it('renders the suggestion as plain text (no create shortcut) for a kid viewing a sibling', async () => {
    mockApi(me('p1', [])) // Wally, no goal.manage, viewing Lottie
    renderProfile()
    expect(await screen.findByText(/Read 20 books/)).toBeInTheDocument()
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/household'), expect.anything()))
    expect(screen.queryByRole('button', { name: /Read 20 books/ })).not.toBeInTheDocument()
  })

  it('offers the suggestion as a create shortcut to a goal.manage holder', async () => {
    mockApi(me('p3', ['goal.manage'])) // an adult/manager viewing Lottie
    renderProfile()
    expect(await screen.findByRole('button', { name: /Read 20 books/ })).toBeInTheDocument()
  })
})
