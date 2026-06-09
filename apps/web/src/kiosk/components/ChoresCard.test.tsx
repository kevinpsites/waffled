import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { ChoresCard } from './ChoresCard'

function mockChores(people: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ date: '2026-06-08', people }),
  })) as unknown as typeof fetch
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ChoresCard />
    </MemoryRouter>
  )
}

describe('ChoresCard', () => {
  it('renders a ring per person with chores', async () => {
    mockChores([
      { id: '1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false, total: 4, done: 2, stars: 14 },
      { id: '2', name: 'Lottie', avatarEmoji: '🦄', colorHex: '#8A5CF0', memberType: 'kid', isAdmin: false, total: 6, done: 5, stars: 24 },
    ])
    renderCard()
    expect(await screen.findByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('2 of 4 done')).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument()
    expect(screen.getByText('24')).toBeInTheDocument()
  })

  it('hides people with no chores and shows the empty state', async () => {
    mockChores([
      { id: '1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true, total: 0, done: 0, stars: 0 },
    ])
    renderCard()
    expect(await screen.findByText(/No chores yet/)).toBeInTheDocument()
    expect(screen.queryByText('Kevin')).not.toBeInTheDocument()
  })
})
