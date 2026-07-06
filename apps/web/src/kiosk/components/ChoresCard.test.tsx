import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ChoresCard } from './ChoresCard'

const CURRENCIES = [
  { id: 'c1', key: 'stars', label: 'Stars', symbol: '⭐', color: '#f2b01e', isDefault: true, spendable: true, sortOrder: 0 },
]

// Mock chores/today, currencies, and household. `capabilities` controls whether
// the current person holds reward.grant (drives the Spot-award quick-tap).
function mockAll(people: unknown[], capabilities: string[] = []) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/chores/today')) return { ok: true, json: async () => ({ date: '2026-06-08', people }) }
    if (u.includes('/api/currencies')) return { ok: true, json: async () => ({ currencies: CURRENCIES }) }
    if (u.includes('/api/household')) return {
      ok: true,
      json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { id: 'me', name: 'Kevin', memberType: 'adult', isAdmin: false, capabilities } }),
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const PEOPLE = [
  { id: '1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false, total: 4, done: 2, stars: 14 },
  { id: '2', name: 'Lottie', avatarEmoji: '🦄', colorHex: '#8A5CF0', memberType: 'kid', isAdmin: false, total: 6, done: 5, stars: 24 },
]

function renderCard() {
  return render(
    <MemoryRouter>
      <ChoresCard />
    </MemoryRouter>
  )
}

describe('ChoresCard', () => {
  it('renders a ring per person with chores', async () => {
    mockAll(PEOPLE)
    renderCard()
    expect(await screen.findByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('2 of 4 done')).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument()
    expect(screen.getByText('24')).toBeInTheDocument()
  })

  it('hides people with no chores and shows the empty state', async () => {
    mockAll([
      { id: '1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true, total: 0, done: 0, stars: 0 },
    ])
    renderCard()
    expect(await screen.findByText(/No chores yet/)).toBeInTheDocument()
    expect(screen.queryByText('Kevin')).not.toBeInTheDocument()
  })

  it('shows the Spot award quick-tap for a reward.grant holder and opens the modal', async () => {
    mockAll(PEOPLE, ['reward.grant'])
    renderCard()
    const trigger = await screen.findByRole('button', { name: /Spot award/i })
    expect(trigger).toBeInTheDocument()
    fireEvent.click(trigger)
    // No preset → the modal's family picker renders
    expect(await screen.findByRole('radiogroup')).toBeInTheDocument()
  })

  it('hides the Spot award quick-tap from someone without reward.grant', async () => {
    mockAll(PEOPLE, [])
    renderCard()
    expect(await screen.findByText('Wally')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Spot award/i })).not.toBeInTheDocument()
    })
  })
})
