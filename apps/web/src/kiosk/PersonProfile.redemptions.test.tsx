import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { PersonProfile } from './PersonProfile'

const redemption = {
  id: 'r1', title: 'Movie night', emoji: '🎬', cost: 5, currency: 'stars',
  status: 'pending', requestedBy: 'requester', ledgerId: null, refundLedgerId: null,
  createdAt: '2026-07-31T12:00:00Z',
}

const overview = {
  person: { id: 'subject', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B', age: 7, memberType: 'kid' },
  activeGoals: 0, topStreak: 0, stars: 5,
  currencies: [{ key: 'stars', label: 'Stars', symbol: '⭐', color: '#f2b01e', isDefault: true }],
  balances: [{ currency: 'stars', balance: 5 }], goals: [], categoryBalance: [],
  insight: { lean: [], light: [], suggestions: [], text: 'A balanced week.' },
  recentLedger: [], redemptions: [redemption], rewardShop: [], savingToward: null,
  streak: { days: 0, week: [] },
}

function mockApi(person: { id: string; capabilities: string[] }) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const path = String(url)
    if (path.includes('/api/persons/subject/overview')) return { ok: true, json: async () => overview }
    if (path.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists: [] }) }
    if (path.includes('/api/conversions')) return { ok: true, json: async () => ({ conversions: [] }) }
    if (path.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [overview.person] }) }
    if (path.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' },
          person: { ...person, name: 'Viewer', memberType: 'kid', isAdmin: false },
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderProfile() {
  return render(
    <MemoryRouter initialEntries={['/person/subject']}>
      <Routes><Route path="/person/:id" element={<PersonProfile />} /></Routes>
    </MemoryRouter>
  )
}

describe('PersonProfile redemption cancellation gating', () => {
  it('does not offer Cancel to the redemption subject when somebody else requested it', async () => {
    mockApi({ id: 'subject', capabilities: [] })
    renderProfile()
    await waitFor(() => expect(screen.getByText('Movie night')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('offers Cancel to the actual requester even from another person\'s profile', async () => {
    mockApi({ id: 'requester', capabilities: [] })
    renderProfile()
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('offers Cancel to a reward approver', async () => {
    mockApi({ id: 'approver', capabilities: ['reward.approve'] })
    renderProfile()
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })
})
