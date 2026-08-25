import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Rhythms } from './Rhythms'

// Editing, retiring and pausing — plus the period state `GET /api/rhythms` now
// carries, which is what lets this screen answer "is this handled?" for a rhythm
// months away from its booking runway. `/attention` deliberately can't: it answers
// the narrower "what needs attention by <horizon>?".

const base = {
  emoji: null,
  notes: null,
  personId: null,
  autoSchedule: false,
  rrule: null,
  leadTime: '14 days',
  lastCompletedAt: null,
  nextDueAt: null,
  startsOn: null,
  isActive: true,
}

// Booked for this period, and nowhere near needing attention.
const temple = {
  ...base,
  id: 'r-temple',
  title: 'Temple visit',
  emoji: '🛕',
  satisfiedBy: 'scheduling' as const,
  every: '3 mons',
  startsOn: '2026-07-01',
  personId: 'p1',
  currentPeriodStart: '2026-07-01',
  currentPeriodEnd: '2026-10-01',
  satisfied: true,
}

// Unbooked, but its runway hasn't opened — the case attention structurally can't
// report and the old screen therefore couldn't show at all.
const selfCare = {
  ...base,
  id: 'r-selfcare',
  title: 'Self-care day',
  satisfiedBy: 'scheduling' as const,
  every: '3 mons',
  startsOn: '2026-07-01',
  currentPeriodStart: '2026-10-01',
  currentPeriodEnd: '2027-01-01',
  satisfied: false,
}

const paused = {
  ...base,
  id: 'r-paused',
  title: 'Gutter check',
  satisfiedBy: 'scheduling' as const,
  every: '6 mons',
  startsOn: '2026-01-01',
  isActive: false,
  currentPeriodStart: '2026-07-01',
  currentPeriodEnd: '2027-01-01',
  satisfied: false,
}

const filter = {
  ...base,
  id: 'r-filter',
  title: 'Air filter',
  satisfiedBy: 'completion' as const,
  every: '3 mons',
  lastCompletedAt: '2026-08-01T09:00:00.000Z',
  nextDueAt: '2026-11-01T09:00:00.000Z',
  currentPeriodStart: null,
  currentPeriodEnd: null,
  satisfied: true,
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi(rhythms: unknown[], items: unknown[] = []) {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/rhythms/attention')) return { ok: true, json: async () => ({ items }) }
    if (u.includes('/api/persons')) {
      return { ok: true, json: async () => ({ persons: [{ id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true }] }) }
    }
    if (method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
    if (u.endsWith('/api/rhythms') && method === 'GET') return { ok: true, json: async () => ({ rhythms }) }
    return { ok: true, json: async () => ({ rhythm: { ...temple, leadTime: '3 days 12:00:00' } }) }
  }) as unknown as typeof fetch
}

const renderScreen = () => render(<MemoryRouter><Rhythms /></MemoryRouter>)

// A row carries one primary verb; everything else is behind its ··· menu.
const openMenu = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^more for ${title}$`, 'i') }))

// Paused rhythms are collapsed behind a summary that NAMES them — "2 paused" alone
// makes you open it to find out which, every single time.
const expandPaused = async () =>
  fireEvent.click(await screen.findByRole('button', { name: /paused/i }))

const patches = () => calls.filter((c) => c.method === 'PATCH')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-18T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('Rhythms — where each one stands', () => {
  it('says a period is handled even when the rhythm is nowhere near its runway', async () => {
    mockApi([temple])
    renderScreen()
    await screen.findByText('Temple visit')
    // Said in the language of the shape rather than as a status badge: for a booking
    // rhythm, "handled" only ever meant "something is on the calendar for it".
    expect(screen.getByText(/on the calendar for this one/i)).toBeInTheDocument()
    // Nothing here may read as follow-through — we never asked whether they went.
    expect(screen.queryByText(/streak|on track|completed/i)).toBeNull()
  })

  it('offers to book a period whose runway has not opened yet', async () => {
    mockApi([selfCare])
    renderScreen()
    await screen.findByText('Self-care day')
    expect(screen.getByText(/not on the calendar yet/i)).toBeInTheDocument()
    // Months from its runway it sits in Steady, which carries no primary button — but
    // booking early is exactly the case /attention structurally cannot report, so the
    // capability has to survive the quietening. It moves into the menu, not away.
    openMenu('Self-care day')
    expect(screen.getByRole('button', { name: /book a time for self-care day/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /skip this period for self-care day/i })).toBeInTheDocument()
  })

  it('does not offer to skip a period that is already handled', async () => {
    mockApi([temple])
    renderScreen()
    await screen.findByText('Temple visit')
    openMenu('Temple visit')
    expect(screen.queryByRole('button', { name: /skip this period/i })).toBeNull()
  })

  it('lets attention override the list: a due item is not also "handled"', async () => {
    // `satisfied` for the completion shape is "not yet due", but the due query fires
    // a whole lead time earlier — so both can be true at once. Attention wins.
    mockApi([filter], [{ kind: 'due', rhythm: filter, dueAt: '2026-11-01T09:00:00.000Z', overdue: false }])
    renderScreen()
    await screen.findByText('Air filter')
    // It lands in the band the server is nudging about, not in Steady — which is what
    // "attention wins" now looks like, the grouping having replaced the badge.
    expect(screen.getByText('Needs you now')).toBeInTheDocument()
    expect(screen.queryByText(/handled/i)).toBeNull()
  })
})

describe('Rhythms — pausing', () => {
  it('makes no claim about nudging something that is switched off', async () => {
    // listAttention filters `and is_active`, so a paused rhythm nudges nobody.
    mockApi([paused])
    renderScreen()
    await expandPaused()
    expect(screen.getByText('Gutter check')).toBeInTheDocument()
    expect(screen.queryByText(/nudging/i)).toBeNull()
  })

  it('shows a paused rhythm as paused and stops offering to act on its period', async () => {
    mockApi([paused])
    renderScreen()
    // Named in the summary before it is even expanded.
    expect(await screen.findByRole('button', { name: /1 paused . gutter check/i })).toBeInTheDocument()
    await expandPaused()
    openMenu('Gutter check')
    expect(screen.queryByRole('button', { name: /book a time/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /skip this period/i })).toBeNull()
    expect(screen.queryByText(/not on the calendar yet/i)).toBeNull()
  })

  it('resumes a paused rhythm', async () => {
    mockApi([paused])
    renderScreen()
    await expandPaused()
    openMenu('Gutter check')
    fireEvent.click(screen.getByRole('button', { name: /resume gutter check/i }))
    await waitFor(() => expect(patches().length).toBe(1))
    expect(patches()[0].url).toContain('/api/rhythms/r-paused')
    expect(patches()[0].body).toEqual({ isActive: true })
  })

  it('pauses an active one', async () => {
    mockApi([temple])
    renderScreen()
    await screen.findByText('Temple visit')
    openMenu('Temple visit')
    fireEvent.click(screen.getByRole('button', { name: /pause temple visit/i }))
    await waitFor(() => expect(patches().length).toBe(1))
    expect(patches()[0].body).toEqual({ isActive: false })
  })
})

describe('Rhythms — an overdue maintenance rhythm', () => {
  it('still says it is overdue when attention has not been fetched', async () => {
    // `satisfied` is `next_due_at > now()`, so an overdue rhythm is genuinely
    // unsatisfied. The row must not go silent just because the attention call is
    // in flight or failed.
    mockApi([{ ...filter, nextDueAt: '2026-08-16T09:00:00.000Z', satisfied: false }])
    renderScreen()
    await screen.findByText('Air filter')
    const cd = screen.getByText('days late').closest('.rhy-cd')
    expect(cd?.textContent).toContain('2')
  })
})

describe('Rhythms — editing', () => {
  async function openEditor(title = 'Temple visit') {
    await screen.findByText(title)
    openMenu(title)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^edit ${title}$`, 'i') }))
    return screen.getByRole('dialog')
  }

  it('sends only the fields that are safe to change in place', async () => {
    mockApi([temple])
    renderScreen()
    const dialog = await openEditor()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Temple' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(patches().length).toBe(1))
    const body = patches()[0].body!
    expect(body.title).toBe('Temple')
    expect(body.every).toBe('3 months')
    // Re-anchoring a live rhythm would re-interpret its skips and re-point its
    // bookings, so the shape and the anchor are not editable at all.
    expect(body).not.toHaveProperty('satisfiedBy')
    expect(body).not.toHaveProperty('startsOn')
    expect(body).not.toHaveProperty('autoSchedule')
    expect(body).not.toHaveProperty('rrule')
  })

  it('clears an assignee as null, never an empty string', async () => {
    // `person_id = $9::uuid` — an empty string reaches Postgres as ''::uuid and 500s.
    mockApi([temple])
    renderScreen()
    const dialog = await openEditor()
    fireEvent.change(within(dialog).getByLabelText(/^who$/i), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(patches().length).toBe(1))
    expect(patches()[0].body!.personId).toBeNull()
  })

  it('states the anchor as a deliberate boundary, with the way out next to it', async () => {
    mockApi([temple])
    renderScreen()
    const dialog = await openEditor()
    expect(within(dialog).getByText(/moving the anchor/i)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /retire/i })).toBeInTheDocument()
    // The anchor fields themselves are simply not offered.
    expect(within(dialog).queryByLabelText(/periods start/i)).toBeNull()
    expect(within(dialog).queryByLabelText(/put it on the calendar automatically/i)).toBeNull()
  })

  it('retires a rhythm behind a confirm step', async () => {
    mockApi([temple])
    renderScreen()
    const dialog = await openEditor()
    fireEvent.click(within(dialog).getByRole('button', { name: /retire/i }))
    // Nothing is destroyed until the confirm.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^retire it$/i }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/rhythms/r-temple'))).toBe(true))
  })

  it('shows the runway the server settled on, not the one that was asked for', async () => {
    // The server re-clamps leadTime to half the cadence, so a 14-day runway on a weekly
    // rhythm is stored as 3 days 12:00:00. Asserted in the editor rather than on the
    // row: the register is about WHEN each rhythm is next wanted, and a nudge setting
    // repeated on every row was noise. This is the screen where the number is chosen,
    // and so the screen where being shown a number the server discarded would mislead.
    mockApi([{ ...temple, every: '7 days', leadTime: '3 days 12:00:00' }])
    renderScreen()
    const dialog = await openEditor()
    // It now sits next to the field it explains, rather than floating in the form.
    fireEvent.click(within(dialog).getByRole('button', { name: /more options/i }))
    expect(within(dialog).getByText(/last 3 days/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/last 14 days/i)).toBeNull()
  })
})
