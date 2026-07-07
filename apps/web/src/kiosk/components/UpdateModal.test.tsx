import { render, screen, waitFor } from '@testing-library/react'
import { UpdateModal } from './UpdateModal'

const ok = (b: unknown) => ({ ok: true, json: async () => b })
const adminPerson = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#333', capabilities: [] }
const kidPerson = { ...adminPerson, id: 'p2', name: 'Wally', memberType: 'kid', isAdmin: false }
const household = { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }
const updatesBody = (updateAvailable: boolean) => ({
  enabled: true,
  current: { version: '0.2.3', sha: 'abc' },
  latest: { tag: 'v0.2.4', url: 'https://github.com/kevinpsites/waffled/releases/tag/v0.2.4', publishedAt: null },
  updateAvailable,
})

function mockApi(opts: { admin: boolean; updateAvailable?: boolean }): string[] {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/household')) return ok({ provisioned: true, household, person: opts.admin ? adminPerson : kidPerson })
    if (u.includes('/api/updates')) return ok(updatesBody(opts.updateAvailable ?? true))
    return ok({})
  }) as unknown as typeof fetch
  return calls
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('UpdateModal', () => {
  it('shows an admin the update, with changelog + upgrade links', async () => {
    mockApi({ admin: true, updateAvailable: true })
    render(<UpdateModal />)
    expect(await screen.findByText(/Waffled 0\.2\.4 is here/i)).toBeInTheDocument()
    expect(screen.getByText('./waffled upgrade')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view changelog/i }).getAttribute('href')).toContain('/releases/tag/v0.2.4')
    expect(screen.getByRole('link', { name: /how to upgrade/i }).getAttribute('href')).toContain('upgrading.md')
  })

  it('stays hidden when already up to date', async () => {
    const calls = mockApi({ admin: true, updateAvailable: false })
    render(<UpdateModal />)
    await waitFor(() => expect(calls.some((u) => u.includes('/api/updates'))).toBe(true))
    expect(screen.queryByText(/is here/i)).not.toBeInTheDocument()
  })

  it('stays hidden once that version was dismissed', async () => {
    localStorage.setItem('waffled.update.dismissed', 'v0.2.4')
    const calls = mockApi({ admin: true, updateAvailable: true })
    render(<UpdateModal />)
    await waitFor(() => expect(calls.some((u) => u.includes('/api/updates'))).toBe(true))
    expect(screen.queryByText(/is here/i)).not.toBeInTheDocument()
  })

  it('never asks the update endpoint for a non-admin', async () => {
    const calls = mockApi({ admin: false, updateAvailable: true })
    render(<UpdateModal />)
    await waitFor(() => expect(calls.some((u) => u.includes('/api/household'))).toBe(true))
    await new Promise((r) => setTimeout(r, 10)) // let any (unwanted) follow-up fire
    expect(calls.some((u) => u.includes('/api/updates'))).toBe(false)
    expect(screen.queryByText(/is here/i)).not.toBeInTheDocument()
  })
})
