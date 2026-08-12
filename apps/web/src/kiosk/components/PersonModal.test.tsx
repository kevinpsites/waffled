import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PersonModal } from './PersonModal'
import type { SettingsMember } from '../../lib/api'

// Saving a member used to swallow every failure in a bare `catch` — the button
// just un-busied itself and nothing said why. That hid a real dead end: a member
// holding a color from before the server validated colors would 400 on every
// save, silently, forever.

const member = {
  id: 'p1',
  name: 'Bram',
  memberType: 'kid',
  isAdmin: false,
  avatarEmoji: '🙂',
  colorHex: '#2F7FED',
  allergens: [],
  showOnKiosk: true,
  hasLogin: false,
  loginEmail: null,
  hasPassword: false,
  hasPin: false,
  isOwner: false,
} as unknown as SettingsMember

function mockSave(response: { ok: boolean; status?: number; body?: unknown }) {
  globalThis.fetch = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body ?? { person: member },
  })) as unknown as typeof fetch
}

describe('PersonModal save failures', () => {
  it('surfaces the server’s reason and keeps the modal open', async () => {
    mockSave({ ok: false, status: 400, body: { error: 'BadRequest', message: 'colorHex must be a #RRGGBB hex color' } })
    const onClose = vi.fn()
    render(<PersonModal person={member} onClose={onClose} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('colorHex must be a #RRGGBB hex color')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // …and the form is usable again, not stuck on "Saving…".
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })

  it('falls back to a plain message when the server gives no reason', async () => {
    mockSave({ ok: false, status: 500, body: {} })
    render(<PersonModal person={member} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/couldn’t save/i)).toBeInTheDocument()
  })

  it('closes on a successful save', async () => {
    mockSave({ ok: true })
    const onClose = vi.fn()
    render(<PersonModal person={member} onClose={onClose} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
