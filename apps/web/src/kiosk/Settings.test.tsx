import { render, screen, fireEvent } from '@testing-library/react'
import { Settings } from './Settings'

const household = { id: 'h1', name: 'The Family', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }
const members = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED', birthday: null, showOnKiosk: true, hasLogin: true, isOwner: true },
  { id: 'p2', name: 'Wally', memberType: 'kid', isAdmin: false, avatarEmoji: '🐢', colorHex: '#25A368', birthday: '2018-05-01', showOnKiosk: true, hasLogin: false, isOwner: false },
]

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
    if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Settings screen', () => {
  it('renders the sub-nav and Family & people with member role lines', async () => {
    mockApi()
    render(<Settings />)

    expect(screen.getByText('Family & people')).toBeInTheDocument() // nav item
    expect(await screen.findByText('Kevin')).toBeInTheDocument()
    expect(screen.getByText(/Adult · Owner · signed in/)).toBeInTheDocument()
    expect(screen.getByText('Wally')).toBeInTheDocument()
    expect(screen.getByText(/Kid · age \d+ · managed by parents/)).toBeInTheDocument()

    // household settings
    expect(screen.getByText('Household name')).toBeInTheDocument()
    expect(screen.getByText('Week starts on')).toBeInTheDocument()
  })

  it('opens the Add-a-person modal', async () => {
    mockApi()
    render(<Settings />)
    fireEvent.click(await screen.findByText(/Add a person/))
    expect(document.querySelector('.modal-card')).toBeTruthy()
    expect(screen.getByText('Add a person', { selector: '.nk-serif' })).toBeInTheDocument()
  })

  it('switches to a placeholder sub-tab', async () => {
    mockApi()
    render(<Settings />)
    await screen.findByText('Kevin')
    fireEvent.click(screen.getByText('Notifications'))
    expect(screen.getByText(/Push to phones/)).toBeInTheDocument()
  })
})
