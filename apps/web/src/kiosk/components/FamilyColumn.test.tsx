import { render, screen } from '@testing-library/react'
import { FamilyColumn } from './FamilyColumn'

function mockPersons(persons: unknown[]) {
  // FamilyColumn also renders the GroceryCard, which fetches its own list.
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ persons, items: [] }) })) as unknown as typeof fetch
}

describe('FamilyColumn', () => {
  it('renders the real family from the api', async () => {
    mockPersons([
      { id: '1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED' },
      { id: '2', name: 'Wally', memberType: 'kid', isAdmin: false, avatarEmoji: '🐢', colorHex: '#25A368' },
    ])
    render(<FamilyColumn />)
    expect(await screen.findByText('Kevin')).toBeInTheDocument()
    expect(screen.getByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('2 members')).toBeInTheDocument()
  })

  it('shows a sign-in message when the api rejects', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch
    render(<FamilyColumn />)
    expect(await screen.findByText(/Sign this kiosk in to see your family/)).toBeInTheDocument()
  })

  it('shows an empty state with no members', async () => {
    mockPersons([])
    render(<FamilyColumn />)
    expect(await screen.findByText(/No family members yet/)).toBeInTheDocument()
  })
})
