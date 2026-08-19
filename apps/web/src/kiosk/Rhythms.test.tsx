import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Rhythms } from './Rhythms'

// The management screen: the whole register, what state each one is in, and the
// way a new one gets made. The two shapes are kept visibly apart because they
// answer different questions — "did you do it?" vs "is it on the calendar?".

const filter = {
  id: 'r-filter',
  title: 'Air filter',
  emoji: '🌬️',
  notes: 'Furnace, 20x25x1',
  personId: null,
  satisfiedBy: 'completion' as const,
  every: '3 mons',
  startsOn: null,
  autoSchedule: false,
  rrule: null,
  leadTime: '14 days',
  lastCompletedAt: '2026-05-16T09:00:00.000Z',
  nextDueAt: '2026-08-16T09:00:00.000Z',
  isActive: true,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  satisfied: false,
}

const temple = {
  id: 'r-temple',
  title: 'Temple visit',
  emoji: '🛕',
  notes: null,
  personId: null,
  satisfiedBy: 'scheduling' as const,
  every: '3 mons',
  startsOn: '2026-07-01',
  autoSchedule: false,
  rrule: null,
  leadTime: '14 days',
  lastCompletedAt: null,
  nextDueAt: null,
  isActive: true,
  currentPeriodStart: '2026-07-01',
  currentPeriodEnd: '2026-10-01',
  satisfied: false,
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi(rhythms: unknown[], items: unknown[] = []) {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/rhythms/attention')) return { ok: true, json: async () => ({ items }) }
    if (u.endsWith('/api/rhythms') && (init?.method ?? 'GET') === 'GET') return { ok: true, json: async () => ({ rhythms }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [{ id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true }] }) }
    return { ok: true, json: async () => ({ rhythm: { ...temple, id: 'r-new' }, ok: true }) }
  }) as unknown as typeof fetch
}

function renderScreen() {
  return render(<MemoryRouter><Rhythms /></MemoryRouter>)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-18T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('Rhythms screen', () => {
  it('lists both shapes, spelling out the Postgres interval', async () => {
    mockApi([filter, temple])
    renderScreen()
    expect(await screen.findByText('Air filter')).toBeInTheDocument()
    expect(screen.getByText('Temple visit')).toBeInTheDocument()
    expect(screen.getAllByText(/every 3 months/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/3 mons/)).toBeNull()
  })

  it('says what closes out each shape, without asking a scheduling one whether it happened', async () => {
    mockApi([filter, temple])
    renderScreen()
    await screen.findByText('Temple visit')
    // The maintenance shape keeps a record of when it was last done.
    expect(screen.getByText(/last done/i)).toBeInTheDocument()
    // The scheduling shape has none, and must not grow one.
    expect(screen.queryByText(/streak|on track/i)).toBeNull()
  })

  it('asks attention no further ahead than today, never a wider horizon', async () => {
    // `to` is both the horizon AND the date that picks which period a scheduling
    // rhythm reports on — asking further out silently answers about a later period.
    mockApi([temple])
    renderScreen()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/rhythms/attention'))).toBe(true))
    const url = calls.find((c) => c.url.includes('/api/rhythms/attention'))!.url
    expect(url).toContain('to=2026-08-18')
  })

  it('flags the ones needing attention and lets a period be skipped from here', async () => {
    mockApi([temple], [{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    renderScreen()
    await screen.findByText('Temple visit')
    expect(screen.getByText(/not on the calendar yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /skip this period for temple visit/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-temple/skip'))).toBe(true))
  })

  it('creates a maintenance rhythm with a first due date', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /you do it/i }))
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Smoke detector batteries' } })
    fireEvent.change(within(dialog).getByLabelText(/^every$/i), { target: { value: '6' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.change(within(dialog).getByLabelText(/first due/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^create rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(body.title).toBe('Smoke detector batteries')
    expect(body.satisfiedBy).toBe('completion')
    expect(body.every).toBe('6 months')
    expect(body.nextDueAt).toBe(new Date('2026-09-01T09:00').toISOString())
    // A completion rhythm has no period grid, so it must not send one.
    expect(body.startsOn).toBeUndefined()
  })

  it('creates a booking rhythm anchored on a period start', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /it gets scheduled/i }))
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Self-care day' } })
    fireEvent.change(within(dialog).getByLabelText(/^every$/i), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.change(within(dialog).getByLabelText(/periods start/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^create rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(body.satisfiedBy).toBe('scheduling')
    expect(body.startsOn).toBe('2026-09-01')
    expect(body.every).toBe('1 months')
    expect(body.nextDueAt).toBeUndefined()
  })

  it('requires a repeat rule before it will auto-schedule, since the server rejects one without it', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /it gets scheduled/i }))
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Trash night' } })
    fireEvent.change(within(dialog).getByLabelText(/periods start/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByLabelText(/put it on the calendar automatically/i))
    fireEvent.click(within(dialog).getByRole('button', { name: /^create rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(body.autoSchedule).toBe(true)
    expect(String(body.rrule)).toMatch(/^FREQ=/)
  })

  it('explains itself when the household has no rhythms yet', async () => {
    mockApi([])
    renderScreen()
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument()
  })
})
