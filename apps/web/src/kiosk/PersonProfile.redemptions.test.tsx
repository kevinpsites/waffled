import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, Route, Routes } from 'react-router'
import { PersonProfile } from './PersonProfile'
import type { PersonOverview } from '../lib/api'

const redemption = {
  id: 'r1', title: 'Movie night', emoji: '🎬', cost: 5, currency: 'stars',
  status: 'pending', requestedBy: 'requester', ledgerId: null, refundLedgerId: null,
  createdAt: '2026-07-31T12:00:00Z',
}

const overview: PersonOverview = {
  person: { id: 'subject', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0794B', age: 7, memberType: 'kid' },
  activeGoals: 0, topStreak: 0, stars: 5,
  currencies: [{ id: 'currency-1', key: 'stars', label: 'Stars', symbol: '⭐', color: '#f2b01e', isDefault: true, spendable: true, sortOrder: 0 }],
  balances: [{ currency: 'stars', balance: 5 }], goals: [], categoryBalance: [],
  insight: { lean: [], light: [], suggestions: [], text: 'A balanced week.' },
  recentLedger: [], redemptions: [redemption], rewardShop: [], savingToward: null,
  streak: { days: 0, week: [] },
}

function mockApi(
  person: { id: string; capabilities: string[] },
  settings: Record<string, unknown> = {},
  profile: PersonOverview = overview
) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const path = String(url)
    if (path.includes('/api/persons/subject/overview')) return { ok: true, json: async () => profile }
    if (path.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists: [] }) }
    if (path.includes('/api/conversions')) return { ok: true, json: async () => ({ conversions: [] }) }
    if (path.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [overview.person] }) }
    if (path.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday', settings },
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
  it('defines distinct treatments for the new canceled and refunded terminal statuses', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/overview.css'), 'utf8')
    expect(css).toMatch(/\.st-canceled\s*\{[^}]*background:[^}]*color:/)
    expect(css).toMatch(/\.st-refunded\s*\{[^}]*background:[^}]*color:/)
  })

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

  it('keeps pending history and Cancel visible when the rewards shop is off', async () => {
    mockApi({ id: 'requester', capabilities: [] }, { chores: { rewards: false } })
    renderProfile()

    expect(await screen.findByText('Movie night')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Shop/ })).not.toBeInTheDocument()
  })

  it('keeps Refund available when only the rewards shop is off', async () => {
    mockApi(
      { id: 'adult', capabilities: ['reward.correct'] },
      { chores: { rewards: false } },
      { ...overview, redemptions: [{ ...redemption, status: 'approved', ledgerId: 'ledger-1' }] }
    )
    renderProfile()

    expect(await screen.findByRole('button', { name: 'Refund' })).toBeInTheDocument()
  })

  it('hides correction and refund actions when the chores module is off', async () => {
    mockApi(
      { id: 'adult', capabilities: ['reward.correct'] },
      { modules: { chores: false }, chores: { rewards: true } },
      {
        ...overview,
        recentLedger: [{
          id: 'ledger-1', amount: 5, reason: 'spot_award', currency: 'stars',
          detail: 'Manual award', note: null, correctionReason: null, correctionOfId: null,
          reversedById: null, reversible: true, redemptionId: null, createdAt: '2026-07-31T12:00:00Z',
        }],
        redemptions: [{ ...redemption, status: 'approved', ledgerId: 'ledger-2' }],
      }
    )
    renderProfile()

    expect(await screen.findByText('Manual award')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument()
  })

  it('keeps historical pending cancellation available when the chores module is off', async () => {
    mockApi(
      { id: 'requester', capabilities: [] },
      { modules: { chores: false }, chores: { rewards: true } }
    )
    renderProfile()

    expect(await screen.findByText('Movie night')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('hides award and saving actions when the chores module is off', async () => {
    mockApi(
      { id: 'adult', capabilities: ['reward.grant'] },
      { modules: { chores: false }, chores: { rewards: true } },
      {
        ...overview,
        savingToward: { id: 'reward-1', title: 'Movie night', emoji: '🎬', cost: 5, currency: 'stars', have: 5, toGo: 0, pct: 100 },
        rewardShop: [{ id: 'reward-1', title: 'Movie night', emoji: '🎬', cost: 5, currency: 'stars', have: 5, toGo: 0 }],
      }
    )
    renderProfile()

    await waitFor(() => expect(screen.getByText('Wallet & chores')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Award stars/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Saving toward/)).not.toBeInTheDocument()
  })
})
