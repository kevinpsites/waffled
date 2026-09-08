import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PersonModal, accessEndDate, dateInTimeZone } from './PersonModal'
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
    render(<PersonModal person={member} householdTimezone="America/Denver" onClose={onClose} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('colorHex must be a #RRGGBB hex color')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // …and the form is usable again, not stuck on "Saving…".
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })

  it('falls back to a plain message when the server gives no reason', async () => {
    mockSave({ ok: false, status: 500, body: {} })
    render(<PersonModal person={member} householdTimezone="America/Denver" onClose={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/couldn’t save/i)).toBeInTheDocument()
  })

  it('closes on a successful save', async () => {
    mockSave({ ok: true })
    const onClose = vi.fn()
    render(<PersonModal person={member} householdTimezone="America/Denver" onClose={onClose} onSaved={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('PersonModal household-local access dates', () => {
  it('recovers the selected end date from exclusive midnight in opposite UTC offsets', () => {
    expect(accessEndDate('2026-06-15T10:00:00.000Z', 'Pacific/Kiritimati')).toBe('2026-06-15')
    expect(accessEndDate('2026-06-16T10:00:00.000Z', 'Pacific/Honolulu')).toBe('2026-06-15')
  })

  it('uses the household day rather than the browser day for date bounds', () => {
    const instant = new Date('2026-01-01T05:00:00.000Z')
    expect(dateInTimeZone(instant, 'Pacific/Kiritimati')).toBe('2026-01-01')
    expect(dateInTimeZone(instant, 'Pacific/Honolulu')).toBe('2025-12-31')
  })

  it('sends a date-only policy for the API to resolve in the household timezone', async () => {
    mockSave({ ok: true })
    const caregiver = {
      ...member,
      memberType: 'caregiver',
      accessExpiresAt: '2026-03-09T07:00:00.000Z',
      showOnKiosk: false,
    } as SettingsMember
    render(<PersonModal person={caregiver} householdTimezone="America/Los_Angeles" onClose={() => {}} onSaved={() => {}} />)

    expect(screen.getByLabelText(/access ends/i)).toHaveValue('2026-03-08')
    fireEvent.change(screen.getByLabelText(/access ends/i), { target: { value: '2026-11-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    const payload = JSON.parse(String(init.body))
    expect(payload).toMatchObject({ accessEndsOn: '2026-11-01' })
    expect(payload).not.toHaveProperty('accessExpiresAt')
  })

  it('prefers the canonical end date after the household timezone changes', () => {
    const caregiver = {
      ...member,
      memberType: 'caregiver',
      accessEndsOn: '2026-03-08',
      // This was the exclusive midnight instant in the household's old timezone.
      accessExpiresAt: '2026-03-09T07:00:00.000Z',
      showOnKiosk: false,
    } as SettingsMember

    render(<PersonModal person={caregiver} householdTimezone="America/Denver" onClose={() => {}} onSaved={() => {}} />)

    expect(screen.getByLabelText(/access ends/i)).toHaveValue('2026-03-08')
  })
})
