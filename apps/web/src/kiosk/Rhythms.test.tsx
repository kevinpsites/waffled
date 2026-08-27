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
  hasSeries: false,
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

// Reads succeed, writes fail — the state a row is in when the server is down, the token
// has gone stale, or a 403 comes back. Every control in the ··· menu is a write.
function mockApiWritesFail(rhythms: unknown[], items: unknown[] = []) {
  mockApi(rhythms, items)
  const reads = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return (reads as typeof fetch)(url as never, init as never)
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null })
    return { ok: false, status: 500, json: async () => ({ error: 'nope' }), text: async () => 'nope' }
  }) as unknown as typeof fetch
}

function renderScreen() {
  return render(<MemoryRouter><Rhythms /></MemoryRouter>)
}

// Each row carries one primary verb; everything else lives behind its ··· menu, so
// most of these have to open it first. The menu is per-row and only one is ever open,
// which is why the assertions below can go straight to the item by name.
function openMenu(title: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^more for ${title}$`, 'i') }))
}

// The shape is no longer a pair of cards at the top of the create form. It is the
// sentence's "counted when" clause, and it opens a listbox rather than a select
// because each option needs its consequence spelled out next to it.
function pickMode(dialog: HTMLElement, label: RegExp) {
  fireEvent.click(within(dialog).getByRole('button', { name: /counted when/i }))
  fireEvent.click(within(screen.getByRole('listbox')).getByText(label))
}

// Anchors, the runway and auto-scheduling are defaults worth having rather than
// questions worth asking, so they sit behind a disclosure now.
function openMore(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /more options/i }))
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
    openMenu('Temple visit')
    fireEvent.click(screen.getByRole('button', { name: /skip this period for temple visit/i }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/rhythms/r-temple/skip'))).toBe(true))
  })

  it('offers the ordinary booking when only this period is empty', async () => {
    // A live series with one empty period does NOT need putting back - it is right there
    // on the calendar. Saying so sent people to a button that built a SECOND weekly series
    // beside the first and doubled every future occurrence. What is missing is one event
    // in one period, which is the same thing a hand-booked row is missing, so it is the
    // same offer. Only the sentence differs, because "yet" would be wrong here: nobody
    // was ever going to book this by hand.
    const auto = {
      ...temple, id: 'r-auto', title: 'Auto temple',
      autoSchedule: true, rrule: 'FREQ=WEEKLY;BYDAY=WE', hasSeries: true,
    }
    mockApi([auto], [{
      kind: 'unscheduled', rhythm: auto,
      periodStart: '2026-07-01', periodEnd: '2026-10-01', hasSeries: true,
    }])
    renderScreen()
    await screen.findByText('Auto temple')
    expect(screen.getByText(/nothing on the calendar this time/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs putting back/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^book a time$/i })).toBeInTheDocument()
  })

  it('asks for the series back only when there is no series left', async () => {
    // The case the button was built for: the recurrence was deleted or ran out, so what
    // is missing really is the series and re-booking one is exactly right.
    const gone = {
      ...temple, id: 'r-gone', title: 'Auto temple',
      autoSchedule: true, rrule: 'FREQ=WEEKLY;BYDAY=WE', hasSeries: false,
    }
    mockApi([gone], [{
      kind: 'unscheduled', rhythm: gone,
      periodStart: '2026-07-01', periodEnd: '2026-10-01', hasSeries: false,
    }])
    renderScreen()
    await screen.findByText('Auto temple')
    expect(screen.getByText(/the series needs putting back/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /put it back/i })).toBeInTheDocument()
  })

  it('leaves a healthy self-booking row reading like any other settled one', async () => {
    // While the series is doing its job there is nothing to report and no button either,
    // so the fact it books itself buys the row nothing and costs it a phrase.
    mockApi([{
      ...temple, id: 'r-ok', title: 'Auto temple', autoSchedule: true, hasSeries: true,
      satisfied: true, bookedAt: '2026-08-19T18:00:00.000Z', bookedAllDay: false,
    }])
    renderScreen()
    await screen.findByText('Auto temple')
    expect(screen.getByText(/on the calendar for this one/i)).toBeInTheDocument()
    expect(screen.queryByText(/needs putting back/i)).toBeNull()
  })

  it('says a skipped period was skipped, rather than claiming a calendar entry', async () => {
    // Skipping exists to send a period quiet WITHOUT inventing an entry for something
    // that isn't happening — so a row that then reports itself as being on the calendar
    // states the one thing the action was chosen to avoid. The server settles both ways
    // and distinguishes them by whether a booking time came back; the row has to read it.
    mockApi([{
      ...temple, id: 'r-skip', title: 'Skipped temple', satisfied: true, bookedAt: null,
    }])
    renderScreen()
    await screen.findByText('Skipped temple')
    expect(screen.getByText(/skipped this one/i)).toBeInTheDocument()
    expect(screen.queryByText(/on the calendar for this one/i)).toBeNull()
    expect(screen.queryByLabelText(/on the calendar/i)).toBeNull()
  })

  it('says so when a row action fails, rather than looking like nothing happened', async () => {
    // Every one of these is a write that can be refused. Swallowing the rejection leaves
    // the row exactly as it was with no message, which reads as "the tap missed" — so the
    // honest response is to press it again, and again. The one thing a failed write must
    // never do is look identical to one that never started.
    mockApiWritesFail([{ ...temple, id: 'r-skip-fail', title: 'Temple visit' }],
      [{ kind: 'unscheduled', rhythm: { ...temple, id: 'r-skip-fail', title: 'Temple visit' },
         periodStart: '2026-07-01', periodEnd: '2026-10-01', hasSeries: false }])
    renderScreen()
    await screen.findByText('Temple visit')
    openMenu('Temple visit')
    fireEvent.click(screen.getByRole('button', { name: /skip this period/i }))
    expect(await screen.findByText(/didn't go through/i)).toBeInTheDocument()
  })

  it('creates a maintenance rhythm with a first due date', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    openMore(dialog)
    pickMode(dialog, /i mark it done/i)
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Smoke detector batteries' } })
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '6' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.change(within(dialog).getByLabelText(/first one due/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^add rhythm$/i }))

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
    openMore(dialog)
    pickMode(dialog, /it's on the calendar/i)
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Self-care day' } })
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.change(within(dialog).getByLabelText(/first period starts/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^add rhythm$/i }))

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
    openMore(dialog)
    pickMode(dialog, /it's on the calendar/i)
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Trash night' } })
    fireEvent.change(within(dialog).getByLabelText(/first period starts/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByLabelText(/put it on the calendar automatically/i))
    fireEvent.click(within(dialog).getByRole('button', { name: /^add rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(body.autoSchedule).toBe(true)
    expect(String(body.rrule)).toMatch(/^FREQ=/)
  })

  // The editor asked for an RRULE in a bare text field ("FREQ=MONTHLY;BYDAY=3SA") while
  // the calendar, two screens away, has a perfectly good day picker for the same question.
  // Reuse the calendar's control rather than growing a second, worse one.
  it('picks the weekday with the calendar\'s chips, not a raw rule', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    openMore(dialog)
    pickMode(dialog, /it's on the calendar/i)
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Trash night' } })
    fireEvent.change(within(dialog).getByLabelText(/first period starts/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByLabelText(/put it on the calendar automatically/i))

    // Wednesday, chosen the same way it's chosen on the calendar.
    fireEvent.click(within(dialog).getByRole('button', { name: 'WE' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^add rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(String(body.rrule)).toContain('BYDAY=WE')
  })

  it('keeps the raw rule as an escape hatch rather than the main control', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    openMore(dialog)
    pickMode(dialog, /it's on the calendar/i)
    fireEvent.click(within(dialog).getByLabelText(/put it on the calendar automatically/i))

    // Still reachable — imported rules and odd cadences need it — but no longer the
    // first thing asked, and named the same as on the calendar.
    expect(within(dialog).getByText(/advanced \(raw rrule\)/i)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/^advanced repeat rule$/i)).toBeNull()
  })

  it('only ever picks one weekday, so the rule cannot outpace the cadence', async () => {
    mockApi([])
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /new rhythm/i }))
    const dialog = screen.getByRole('dialog')
    openMore(dialog)
    pickMode(dialog, /it's on the calendar/i)
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Trash night' } })
    fireEvent.change(within(dialog).getByLabelText(/first period starts/i), { target: { value: '2026-09-01' } })
    fireEvent.click(within(dialog).getByLabelText(/put it on the calendar automatically/i))

    // A rhythm's rule is DERIVED from its cadence — "every week" plus BYDAY=MO,WE would
    // fire twice per period and mean something the cadence never said. Picking a second
    // day replaces the first rather than adding to it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'MO' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'WE' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^add rhythm$/i }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))).toBe(true))
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/rhythms'))!.body!
    expect(String(body.rrule)).toContain('BYDAY=WE')
    expect(String(body.rrule)).not.toContain('MO')
  })

  it('explains itself when the household has no rhythms yet', async () => {
    mockApi([])
    renderScreen()
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument()
  })

  // Completing something already done today changed NOTHING on screen: the row reads
  // "Last done <date> · Next due <date>", and re-completing on the same day recomputes
  // both to the identical string. So the button looked dead and got tapped again — the
  // demo database ended up with four rows for one air-filter change. The row has to say
  // it landed, which is the same thing a habit goal already does ("Done for today ✓").
  it('says a rhythm done today is done, rather than offering the same button again', async () => {
    const doneToday = { ...filter, lastCompletedAt: '2026-08-18T09:00:00.000Z', nextDueAt: '2026-11-18T09:00:00.000Z' }
    mockApi([doneToday])
    renderScreen()
    await screen.findByText('Air filter')
    expect(screen.getByRole('button', { name: /done today/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^i did it$/i })).toBeNull()
  })

  it('refuses to log a second completion for a day already logged', async () => {
    const doneToday = { ...filter, lastCompletedAt: '2026-08-18T09:00:00.000Z', nextDueAt: '2026-11-18T09:00:00.000Z' }
    mockApi([doneToday])
    renderScreen()
    await screen.findByText('Air filter')
    fireEvent.click(screen.getByRole('button', { name: /done today/i }))
    // Give any in-flight request a chance to appear before asserting it didn't.
    await waitFor(() => expect(screen.getByText('Air filter')).toBeInTheDocument())
    expect(calls.some((c) => c.url.includes('/complete'))).toBe(false)
  })

  // "How can I mark something done as late?" — you couldn't. The button always meant
  // "now", so the one shape whose whole premise is that the clock restarts from when you
  // ACTUALLY did it had no way to say when that was. The server already accepted a date.
  it('lets a completion be logged for the day it really happened', async () => {
    mockApi([filter])
    renderScreen()
    await screen.findByText('Air filter')

    openMenu('Air filter')
    fireEvent.click(screen.getByRole('button', { name: /mark air filter done on another day/i }))
    fireEvent.change(screen.getByLabelText(/when did you do it/i), { target: { value: '2026-08-14' } })
    fireEvent.click(screen.getByRole('button', { name: /^log it$/i }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/complete'))).toBe(true))
    const body = calls.find((c) => c.url.includes('/complete'))!.body!
    expect(String(body.completedAt)).toContain('2026-08-14')
  })

  it('refuses a completion dated in the future', async () => {
    mockApi([filter])
    renderScreen()
    await screen.findByText('Air filter')

    openMenu('Air filter')
    fireEvent.click(screen.getByRole('button', { name: /mark air filter done on another day/i }))
    // System time in these tests is 2026-08-18.
    fireEvent.change(screen.getByLabelText(/when did you do it/i), { target: { value: '2026-12-25' } })
    // A rhythm records what happened, so "I did this next Christmas" is not a claim it
    // can accept — the clock would restart from a date that hasn't arrived.
    expect(screen.getByRole('button', { name: /^log it$/i })).toBeDisabled()
  })

  it('still offers the button to a rhythm last done on some other day', async () => {
    mockApi([filter])
    renderScreen()
    await screen.findByText('Air filter')
    expect(screen.getByRole('button', { name: /^i did it$/i })).toBeInTheDocument()
  })
})
