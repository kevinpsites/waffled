import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RhythmsCard } from './RhythmsCard'

const render = () => rtlRender(<MemoryRouter><RhythmsCard /></MemoryRouter>)

// A rhythm is a standing intention with a cadence. The card's job is to say what
// needs attention today — and to say it in the right language for each shape:
// a 'completion' rhythm was done or wasn't; a 'scheduling' rhythm is satisfied by
// an event EXISTING, which is why nothing here may read as follow-through.

const filter = {
  id: 'r-filter',
  title: 'Air filter',
  emoji: '🌬️',
  notes: null,
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
}

const outing = { ...temple, id: 'r-outing', title: 'Family outing', emoji: '🎠', autoSchedule: true, rrule: 'FREQ=MONTHLY;BYDAY=3SA', every: '1 mon' }

const calls: { url: string; method: string; body: unknown }[] = []

function mockAttention(items: unknown[]) {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/rhythms/attention')) return { ok: true, json: async () => ({ items }) }
    return { ok: true, json: async () => ({ ok: true, event: { id: 'ev-new' } }) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-18T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('RhythmsCard', () => {
  it('renders nothing at all when nothing needs attention', async () => {
    mockAttention([])
    const { container } = render()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/rhythms/attention'))).toBe(true))
    await waitFor(() => expect(container.querySelector('.card')).toBeNull())
  })

  it('asks no further ahead than today — a later horizon answers about a later period', async () => {
    mockAttention([])
    render()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/rhythms/attention'))).toBe(true))
    const url = calls.find((c) => c.url.includes('/api/rhythms/attention'))!.url
    // Exact, not `toContain`: a leftover `from=` would survive a substring check,
    // and a second date implies a window this endpoint doesn't have.
    expect(url).toBe('/api/rhythms/attention?to=2026-08-18')
  })

  it('shows a completion rhythm as overdue and marks it done', async () => {
    mockAttention([{ kind: 'due', rhythm: filter, dueAt: '2026-08-16T09:00:00.000Z', overdue: true }])
    render()
    expect(await screen.findByText('Air filter')).toBeInTheDocument()
    expect(screen.getByText(/every 3 months/)).toBeInTheDocument()
    expect(screen.getByText(/2 days overdue/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /mark done/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-filter/complete') && c.method === 'POST')).toBe(true))
  })

  it('asks a scheduling rhythm to be booked, never to be completed', async () => {
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    render()
    expect(await screen.findByText('Temple visit')).toBeInTheDocument()
    expect(screen.getByText(/not on the calendar yet/i)).toBeInTheDocument()
    // The line a rhythm must never cross: no follow-through language.
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull()
    expect(screen.queryByText(/streak|completed|on track/i)).toBeNull()
  })

  it('books a period into a real event from a time picker alone', async () => {
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    render()
    fireEvent.click(await screen.findByRole('button', { name: /book a time/i }))

    // Title and assignee come from the rhythm, so the modal asks for a time and
    // nothing else — no title field to retype.
    expect(screen.queryByLabelText(/title/i)).toBeNull()
    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: '2026-09-12' } })
    fireEvent.change(screen.getByLabelText(/^time$/i), { target: { value: '10:30' } })
    fireEvent.click(screen.getByRole('button', { name: /put it on the calendar/i }))

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-temple/schedule'))).toBe(true))
    const body = calls.find((c) => c.url.endsWith('/api/rhythms/r-temple/schedule'))!.body as { startsAt: string }
    // An explicit ISO instant, not the raw datetime-local string — a booking near a
    // period boundary has to land inside the period it was meant to satisfy.
    expect(body.startsAt).toBe(new Date('2026-09-12T10:30').toISOString())
  })

  it('skips a period without inventing a calendar entry for it', async () => {
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    render()
    fireEvent.click(await screen.findByRole('button', { name: /skip this period for temple visit/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-temple/skip'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/api/rhythms/r-temple/skip'))!.body).toEqual({ periodStart: '2026-07-01' })
  })

  it('offers to put the series back when an auto-scheduled rhythm resurfaces', async () => {
    // An auto_schedule rhythm is normally absent — its recurring event IS the
    // satisfied state. Showing up means the event was deleted or ran out.
    mockAttention([{ kind: 'unscheduled', rhythm: outing, periodStart: '2026-08-01', periodEnd: '2026-09-01' }])
    render()
    expect(await screen.findByText('Family outing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /put it back on the calendar/i })).toBeInTheDocument()
  })
})
