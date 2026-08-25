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

function mockAttention(items: unknown[], all: unknown[] = []) {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/rhythms/attention')) return { ok: true, json: async () => ({ items }) }
    if (u.endsWith('/api/rhythms') && method === 'GET') return { ok: true, json: async () => ({ rhythms: all }) }
    return { ok: true, json: async () => ({ ok: true, event: { id: 'ev-new' } }) }
  }) as unknown as typeof fetch
}

// The status line colours only its first half, so it is two text nodes and
// getByText cannot see across the boundary. Read the whole line instead of
// reshaping the DOM to suit the assertion.
const statusLine = (re: RegExp) =>
  screen.getByText((_t, el) => el?.className === 'rhy-sub tiny muted' && re.test(el.textContent ?? ''))

// Ten rhythms in the register, of which some number want you today. The card's
// header states both, which is the whole point of the redesigned block: you see
// what is being asked of you AND how much you are not being asked about.
const ten = Array.from({ length: 10 }, (_, i) => ({ ...filter, id: `r-${i}`, title: `Rhythm ${i}` }))

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
    // Urgency first, cadence second: on a board read from across a kitchen, "2 days
    // late" is the part worth seeing, and it used to be the second half of the line.
    expect(statusLine(/2 days late . every 3 months/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /i did it for air filter/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-filter/complete') && c.method === 'POST')).toBe(true))
  })

  it('asks a scheduling rhythm to be booked, never to be completed', async () => {
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    render()
    expect(await screen.findByText('Temple visit')).toBeInTheDocument()
    // Every row on this card is something that needs attention, so "not on the
    // calendar yet" was true of all of them and told you nothing. The deadline is
    // the part that differs.
    expect(screen.getByText(/left to book it/i)).toBeInTheDocument()
    expect(screen.queryByText(/not on the calendar yet/i)).toBeNull()
    // The line a rhythm must never cross: no follow-through language.
    expect(screen.queryByRole('button', { name: /mark done/i })).toBeNull()
    expect(screen.queryByText(/streak|completed|on track/i)).toBeNull()
  })

  it('books a period into a real event from a time picker alone', async () => {
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }])
    render()
    fireEvent.click(await screen.findByRole('button', { name: /book a time for temple visit/i }))

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
    expect(screen.getByRole('button', { name: /put the series back on the calendar for family outing/i })).toBeInTheDocument()
  })
  it('says how many want you, and how many there are altogether', async () => {
    mockAttention(
      [{ kind: 'due', rhythm: filter, dueAt: '2026-08-16T09:00:00.000Z', overdue: true }],
      ten
    )
    render()
    expect(await screen.findByText(/1 wants attention/i)).toBeInTheDocument()
    // The register's size is the reassuring half: nine other things are handled.
    expect(await screen.findByRole('link', { name: /all 10/i })).toBeInTheDocument()
  })

  it('does not ask for the register at all on a quiet day', async () => {
    // Most days a quarterly register wants nothing, and the card renders nothing.
    // Fetching the whole list anyway would be a request per board refresh, forever,
    // to render something no one is going to see.
    mockAttention([], ten)
    render()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/rhythms/attention'))).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.some((c) => c.url.endsWith('/api/rhythms') && c.method === 'GET')).toBe(false)
  })

  it('leads with the countdown for something not yet late', async () => {
    mockAttention([{ kind: 'due', rhythm: filter, dueAt: '2026-08-23T09:00:00.000Z', overdue: false }], ten)
    render()
    await screen.findByText('Air filter')
    expect(statusLine(/in 5 days . every 3 months/i)).toBeInTheDocument()
  })

  it('keeps the loud button for the things that are actually late', async () => {
    // Everything on this card wants attention, so making every button primary makes
    // none of them mean anything. The emphasis is reserved for late, or out of time.
    mockAttention([
      { kind: 'due', rhythm: filter, dueAt: '2026-08-16T09:00:00.000Z', overdue: true },
      { kind: 'due', rhythm: { ...filter, id: 'r-soon', title: 'Softener salt' }, dueAt: '2026-08-23T09:00:00.000Z', overdue: false },
    ], ten)
    render()
    await screen.findByText('Air filter')
    expect(screen.getByRole('button', { name: /i did it for air filter/i })).toHaveClass('btn-primary')
    expect(screen.getByRole('button', { name: /i did it for softener salt/i })).not.toHaveClass('btn-primary')
  })

  it('still lets a period be skipped from the board', async () => {
    // Not in the redesign's sketch of this card, and kept anyway: skipping is the
    // one thing here you cannot otherwise do without leaving Today.
    mockAttention([{ kind: 'unscheduled', rhythm: temple, periodStart: '2026-07-01', periodEnd: '2026-10-01' }], ten)
    render()
    expect(await screen.findByRole('button', { name: /skip this period for temple visit/i })).toBeInTheDocument()
  })
})
