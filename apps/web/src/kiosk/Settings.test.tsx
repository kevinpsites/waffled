import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Settings } from './Settings'
import type { PermissionMatrix } from '../lib/api'

const renderSettings = () => render(<MemoryRouter><Settings /></MemoryRouter>)

const displayConfig = {
  screensaverMinutes: 15,
  content: 'photos',
  returnToPicker: true,
  resetHomeMinutes: 3,
  nightDim: { enabled: false, start: '22:00', end: '07:00' },
  photoSource: 'all',
  photoAlbum: null,
  photoInterval: 10,
  photoShuffle: false,
}
const samplePhotos = [
  { id: 'ph1', imageUrl: null, caption: 'a', emoji: '🏖️', colorHex: '#7fc1e8', memory: 'Lake Day', takenAt: null, isFavorite: true, reactions: {}, uploadedBy: null, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ph2', imageUrl: null, caption: 'b', emoji: '🎂', colorHex: '#7fc1e8', memory: 'Birthday', takenAt: null, isFavorite: false, reactions: {}, uploadedBy: null, createdAt: '2026-01-02T00:00:00Z' },
]

const household = { id: 'h1', name: 'The Family', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }
const members = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#2F7FED', birthday: null, showOnKiosk: true, hasLogin: true, isOwner: true },
  { id: 'p2', name: 'Wally', memberType: 'kid', isAdmin: false, avatarEmoji: '🐢', colorHex: '#25A368', birthday: '2018-05-01', showOnKiosk: true, hasLogin: false, isOwner: false },
]

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
    // useHousehold() drives the admin gate — return the owner (an admin).
    if (String(url).includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[0] }) }
    if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Settings screen', () => {
  it('renders the sub-nav and Family & people with member role lines', async () => {
    mockApi()
    renderSettings()

    expect(await screen.findByText('Family & People')).toBeInTheDocument() // nav item
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
    renderSettings()
    fireEvent.click(await screen.findByText(/Add a person/))
    expect(document.querySelector('.modal-card')).toBeTruthy()
    expect(screen.getByText('Add a person', { selector: '.wf-serif' })).toBeInTheDocument()
  })

  it('switches to a placeholder sub-tab', async () => {
    mockApi()
    renderSettings()
    await screen.findByText('Kevin')
    fireEvent.click(screen.getByText('Notifications'))
    expect(screen.getByText(/Push to phones/)).toBeInTheDocument()
  })

  it('shows the Display & Kiosk panel with the family-display toggle', async () => {
    mockApi()
    renderSettings()
    await screen.findByText('Kevin')
    fireEvent.click(screen.getByText('Display & Kiosk'))
    expect(await screen.findByText('Use this browser as the family display')).toBeInTheDocument()
  })

  it('saves screensaver photo-source / interval / shuffle changes', async () => {
    const puts: Array<Record<string, unknown>> = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/kiosk/display')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          puts.push(body)
          return { ok: true, json: async () => body }
        }
        return { ok: true, json: async () => displayConfig }
      }
      if (u.includes('/api/photos')) return { ok: true, json: async () => ({ photos: samplePhotos }) }
      if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
      if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[0] }) }
      if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
      if (u.includes('/api/events')) return { ok: true, json: async () => ({ events: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    renderSettings()
    await screen.findByText('Kevin')
    fireEvent.click(screen.getByText('Display & Kiosk'))

    // The new photo-playback controls render under the Screensaver subheading.
    expect(await screen.findByText('Photo source')).toBeInTheDocument()
    expect(screen.getByText('Transition speed')).toBeInTheDocument()
    expect(screen.getByText('Shuffle photos')).toBeInTheDocument()

    // Favorites-only source → PUT carries photoSource: 'favorites'.
    fireEvent.click(screen.getByText('Favorites only'))
    await waitFor(() => expect(puts.some((p) => p.photoSource === 'favorites')).toBe(true))

    // Transition speed select → PUT carries the new photoInterval.
    const speed = screen.getByDisplayValue('10 seconds') as HTMLSelectElement
    fireEvent.change(speed, { target: { value: '30' } })
    await waitFor(() => expect(puts.some((p) => p.photoInterval === 30)).toBe(true))
  })

  it('renders the permissions grid with a Manage goals column and toggles it', async () => {
    const puts: PermissionMatrix[] = []
    const emptyRow = { 'chore.manage': false, 'chore.approve': false, 'reward.manage': false, 'reward.approve': false, 'goal.manage': false }
    const matrix: PermissionMatrix = { adult: { ...emptyRow }, teen: { ...emptyRow }, kid: { ...emptyRow } }
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/permissions')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { permissions: PermissionMatrix }
          puts.push(body.permissions)
          return { ok: true, json: async () => ({ permissions: body.permissions }) }
        }
        return { ok: true, json: async () => ({ permissions: matrix }) }
      }
      if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
      if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[0] }) }
      if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    renderSettings()
    await screen.findByText('Kevin')

    // The grid renders dynamically from CAPABILITIES — the new goal.manage column
    // shows as a "Manage goals" header.
    expect(await screen.findByText('Manage goals')).toBeInTheDocument()
    // Toggling Teen's Manage goals checkbox PUTs the matrix with it flipped on.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Teen: Manage goals' }))
    await waitFor(() => expect(puts.some((m) => m.teen['goal.manage'] === true)).toBe(true))
  })

  it('shows the System Health panel with component cards (admin)', async () => {
    const report = {
      status: 'degraded',
      version: { pkg: '0.0.0', sha: 'abc123', buildTime: null },
      generatedAt: '2026-06-25T20:00:00Z',
      checks: {
        db: { status: 'ok', total: 3, idle: 1, waiting: 0 },
        migrations: { status: 'ok', applied: 47, available: 47 },
        schedulers: { status: 'ok', jobs: [], note: 'no run history in this process' },
        calendar: { status: 'degraded', pendingPush: 0, failedPush: 2, staleCalendars: 1 },
        storage: { status: 'ok', dir: '/data/media', writable: true },
      },
    }
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/health')) return { ok: true, json: async () => report }
      if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
      if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[0] }) }
      if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    renderSettings()
    await screen.findByText('Kevin')
    fireEvent.click(screen.getByText('System Health'))

    expect(await screen.findByText('Database')).toBeInTheDocument()
    expect(screen.getByText('Calendar sync')).toBeInTheDocument()
    expect(screen.getByText(/Build abc123/)).toBeInTheDocument()
    expect(screen.getByText(/DEGRADED/)).toBeInTheDocument()
  })

  it('hides admin-only tabs from non-admins (only About + Sign out)', async () => {
    // Same data, but the signed-in person is not an admin.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
      if (String(url).includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[1] }) } // Wally, not admin
      if (String(url).includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
    renderSettings()

    expect(await screen.findByText('Waffled — Family Hub')).toBeInTheDocument() // About panel content
    expect(screen.getByText('About', { selector: '.set-navitem' })).toBeInTheDocument()
    expect(screen.getByText(/Sign out/, { selector: '.set-signout' })).toBeInTheDocument()
    expect(screen.queryByText('Family & People')).not.toBeInTheDocument()
    expect(screen.queryByText('Sign-in & Security')).not.toBeInTheDocument()
  })
})
