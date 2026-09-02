import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RhythmModal } from './RhythmModal'

// The create form says the rhythm as a sentence — "🌬 Air filter every 3 months,
// counted when I mark it done, on Kevin" — and then states, underneath it, what that
// sentence will actually do. Everything else is a default worth having, folded away.
//
// The sentence is made of REAL form controls, not clickable spans: each token is an
// input or a select carrying an aria-label, because there is nowhere to hang a visible
// one. The single exception is the mode token, which opens a listbox — the two options
// need their explanations shown, and a <select> has nowhere to put them.

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi() {
  calls.length = 0
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.includes('/api/persons')) {
      return {
        ok: true,
        json: async () => ({
          persons: [{ id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED', memberType: 'adult', isAdmin: true }],
        }),
      }
    }
    return { ok: true, json: async () => ({ rhythm: {} }) }
  }) as unknown as typeof fetch
}

const posts = () => calls.filter((c) => c.method === 'POST')

const filter = {
  id: 'r-filter', title: 'Air filter', emoji: '🌬️', notes: null, personId: null,
  satisfiedBy: 'completion' as const, every: '3 mons', startsOn: null, autoSchedule: false,
  rrule: null, leadTime: '14 days', lastCompletedAt: '2026-05-16T09:00:00.000Z',
  nextDueAt: '2026-08-16T09:00:00.000Z', isActive: true,
  currentPeriodStart: null, currentPeriodEnd: null, satisfied: false, hasSeries: false,
  bookedAt: null, bookedAllDay: null,
}

const openCreate = () => {
  render(<RhythmModal onClose={() => {}} />)
  return screen.getByRole('dialog')
}

function mockHistory(body: unknown) {
  const prev = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: null })
    if (u.includes('/completions')) return { ok: true, json: async () => body }
    return (prev as typeof fetch)(url as never, init as never)
  }) as unknown as typeof fetch
}

const openEdit = (rhythm: unknown = filter) => {
  render(<RhythmModal rhythm={rhythm as never} onClose={() => {}} />)
  return screen.getByRole('dialog')
}

// The mode token is a button, not a select — see the note above.
const openMode = () => fireEvent.click(screen.getByRole('button', { name: /counted when/i }))
const moreOptions = () => screen.getByRole('button', { name: /more options/i })

beforeEach(() => {
  mockApi()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // Local midday, so "today" is the same calendar day either side of UTC.
  vi.setSystemTime(new Date(2026, 7, 19, 12, 0, 0))
})
afterEach(() => vi.useRealTimers())

describe('New rhythm — the sentence', () => {
  it('asks for the whole rhythm as labelled controls, not clickable text', async () => {
    const dialog = openCreate()
    // The four tokens anyone actually has to answer. Keyboard users get to all of
    // them, and so do the edit tests that have always found them this way.
    expect(within(dialog).getByLabelText(/^what$/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^who$/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/how often/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^unit$/i)).toBeInTheDocument()
  })

  it('starts on "I mark it done", the shape that forgives being late', async () => {
    openCreate()
    // Following the redesign, and a deliberate flip from the old default. A booking
    // rhythm builds a period grid and wants the calendar; a completion rhythm needs
    // only a date, and its whole promise is that one late turn moves the next one
    // instead of stacking a miss.
    expect(screen.getByRole('button', { name: /counted when/i })).toHaveTextContent(/i mark it done/i)
  })

  it('explains both shapes where the choice is made', async () => {
    openCreate()
    openMode()
    const list = screen.getByRole('listbox')
    expect(within(list).getByText(/late once/i)).toBeInTheDocument()
    expect(within(list).getByText(/nobody asks later whether it happened/i)).toBeInTheDocument()
  })
})

describe('New rhythm — the consequence card', () => {
  it('names the day it lands and the day it starts asking', async () => {
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '3' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    // Aug 19 + 3 months = Nov 19; the default 14-day runway opens Nov 5.
    await waitFor(() => expect(within(dialog).getByText(/November 19/)).toBeInTheDocument())
    expect(within(dialog).getByText(/November 5/)).toBeInTheDocument()
    // The token shows the choice back, not just the first option.
    expect(within(dialog).getByLabelText(/^unit$/i)).toHaveValue('months')
    expect(within(dialog).getByText(/misses never stack up/i)).toBeInTheDocument()
  })

  it('promises the runway the server will keep, not the one that was typed', async () => {
    // A weekly rhythm cannot hold a 14-day runway — the server trims it to 3. The
    // card must name the day it will really start asking, or it is promising a
    // nudge that never comes.
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '1' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'weeks' } })
    fireEvent.click(moreOptions())
    fireEvent.change(within(dialog).getByLabelText(/start nudging/i), { target: { value: '14' } })
    // Aug 19 + 1 week = Aug 26, trimmed runway of 3 days opens Aug 23.
    await waitFor(() => expect(within(dialog).getByText(/August 26/)).toBeInTheDocument())
    expect(within(dialog).getByText(/August 23/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/August 12/)).toBeNull()
    expect(within(dialog).getByText(/trimmed/i)).toBeInTheDocument()
  })

  it('sizes the default runway to the cadence instead of always offering a fortnight', async () => {
    // 14 days on a weekly rhythm is trimmed to 3 by the server. An untouched form
    // that opened promising a fortnight would be explaining away a clamp nobody
    // asked for, on the very first screen.
    const dialog = openCreate()
    fireEvent.click(moreOptions())
    expect(within(dialog).getByLabelText(/start nudging/i)).toHaveValue(3)
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    expect(within(dialog).getByLabelText(/start nudging/i)).toHaveValue(14)
    expect(within(dialog).queryByText(/trimmed/i)).toBeNull()
  })

  it('says the booking shape closes a window rather than coming due', async () => {
    const dialog = openCreate()
    openMode()
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/it's on the calendar/i))
    expect(within(dialog).getByText(/never ask whether it happened/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/misses never stack up/i)).toBeNull()
  })
})

describe('New rhythm — more options', () => {
  it('keeps the defaults folded away until they are asked for', async () => {
    const dialog = openCreate()
    expect(within(dialog).queryByLabelText(/notes/i)).toBeNull()
    fireEvent.click(moreOptions())
    expect(within(dialog).getByLabelText(/notes/i)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/start nudging/i)).toBeInTheDocument()
  })

  it('offers the anchor it is quoting a date from', async () => {
    // The card promises "next one lands around Nov 19". The input that decides that
    // date has to be reachable, or the promise is unfalsifiable.
    const dialog = openCreate()
    fireEvent.click(moreOptions())
    expect(within(dialog).getByLabelText(/first one due/i)).toBeInTheDocument()
  })
})

describe('New rhythm — what gets created', () => {
  it('dates a completion rhythm one full cadence out, not today', async () => {
    // Anchored at today, every new rhythm arrives already overdue and shouting from
    // "Needs you now" — which is not what "every 3 months, starting now" means.
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Air filter' } })
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '3' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /add rhythm/i }))

    await waitFor(() => expect(posts().length).toBe(1))
    const body = posts()[0].body!
    expect(body.satisfiedBy).toBe('completion')
    expect(body.every).toBe('3 months')
    expect(String(body.nextDueAt)).toContain('2026-11-19')
    // The shape constraint rejects a row carrying both anchors.
    expect(body).not.toHaveProperty('startsOn')
  })

  // `startsOn` does two jobs that quietly disagree. It anchors the period grid —
  // boundaries are startsOn + n × every — and it also decides WHICH nth weekday the rule
  // means. Left as the date the person picked, a "third Saturday" rhythm anchored on the
  // 19th tiles its periods on the 19th, while third Saturdays wander over the 15th to the
  // 21st: one period gets two of them and the next gets none, and a period with nothing
  // in it can never be booked and asks forever.
  //
  // The two jobs are therefore separated here: the grid is anchored on the first of the
  // month, so every period is a calendar month and holds exactly one of any nth weekday,
  // while the rule still reads its ordinal off the date that was actually picked.
  it('anchors a monthly nth-weekday rhythm on the first, so no period comes up empty', async () => {
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Family outing' } })
    openMode()
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/it's on the calendar/i))
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.click(moreOptions())
    fireEvent.click(within(dialog).getByRole('switch', { name: /on the calendar automatically/i }))
    fireEvent.change(within(dialog).getByLabelText(/which day of the month/i), { target: { value: 'weekday' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /add rhythm/i }))

    await waitFor(() => expect(posts().length).toBe(1))
    const body = posts()[0].body!
    // Today is 2026-08-19 — the third Wednesday of August.
    expect(body.startsOn).toBe('2026-08-01')
    expect(body.rrule).toBe('FREQ=MONTHLY;BYDAY=3WE')
  })

  it('leaves the anchor alone when the rule is the same date each month', async () => {
    // "The 19th of every month" needs no snapping: the boundaries and the occurrences
    // are the same day by construction.
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Rent' } })
    openMode()
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/it's on the calendar/i))
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'months' } })
    fireEvent.click(moreOptions())
    fireEvent.click(within(dialog).getByRole('switch', { name: /on the calendar automatically/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /add rhythm/i }))

    await waitFor(() => expect(posts().length).toBe(1))
    expect(posts()[0].body!.startsOn).toBe('2026-08-19')
  })

  it('leaves a weekly cadence alone — its grid and its rule already step together', async () => {
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Every third weekend' } })
    openMode()
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/it's on the calendar/i))
    fireEvent.change(within(dialog).getByLabelText(/how often/i), { target: { value: '3' } })
    fireEvent.change(within(dialog).getByLabelText(/^unit$/i), { target: { value: 'weeks' } })
    fireEvent.click(moreOptions())
    fireEvent.click(within(dialog).getByRole('switch', { name: /on the calendar automatically/i }))
    fireEvent.click(within(dialog).getByRole('button', { name: /add rhythm/i }))

    await waitFor(() => expect(posts().length).toBe(1))
    expect(posts()[0].body!.startsOn).toBe('2026-08-19')
  })

  it('anchors a booking rhythm at the period start instead', async () => {
    const dialog = openCreate()
    fireEvent.change(within(dialog).getByLabelText(/^what$/i), { target: { value: 'Date night' } })
    openMode()
    fireEvent.click(within(screen.getByRole('listbox')).getByText(/it's on the calendar/i))
    fireEvent.click(within(dialog).getByRole('button', { name: /add rhythm/i }))

    await waitFor(() => expect(posts().length).toBe(1))
    const body = posts()[0].body!
    expect(body.satisfiedBy).toBe('scheduling')
    expect(body.startsOn).toBe('2026-08-19')
    expect(body).not.toHaveProperty('nextDueAt')
  })
})

// `GET /:id/completions` and its `averageIntervalDays` have existed and been tested since
// the migration, and were reachable from NO client — the web layer declared the call and
// nothing invoked it. So the register kept a history it could not show you, and the one
// fact it exists to answer ("how often does this ACTUALLY happen?") had nowhere to appear.
//
// The average is the interesting half: a rhythm nominally every 3 months that really runs
// every 5 is telling you the cadence is wrong, and only the server can compute it — over
// every completion, not the page you happened to fetch.
describe('the history a completion rhythm keeps', () => {
  it('shows how often it really happens, beside how often it is meant to', async () => {
    mockHistory({
      completions: [
        { id: 'c3', personId: null, completedAt: '2026-05-16T09:00:00.000Z', notes: null },
        { id: 'c2', personId: null, completedAt: '2026-01-20T09:00:00.000Z', notes: null },
        { id: 'c1', personId: null, completedAt: '2025-09-14T09:00:00.000Z', notes: null },
      ],
      total: 3,
      averageIntervalDays: 122.5,
    })
    openEdit()
    expect(await screen.findByText(/done 3 times/i)).toBeInTheDocument()
    // Bolding the number splits the sentence across elements, so read the whole line.
    const line = screen.getByText((_t, el) =>
      el?.className === 'rhy-anchor' && /done 3 times/i.test(el.textContent ?? ''))
    // Rounded — a household does not need a decimal place on "about every".
    expect(line.textContent).toMatch(/about every 123 days/i)
    // ...and stated against the nominal cadence, which is the comparison worth making.
    expect(line.textContent).toMatch(/every 3 months/i)
    expect(screen.getByText(/May 16/)).toBeInTheDocument()
  })

  it('says nothing about an average it cannot have', async () => {
    // One date is not an interval. The server returns null rather than inventing one, and
    // the row must not fill that in with a number of its own.
    mockHistory({
      completions: [{ id: 'c1', personId: null, completedAt: '2026-05-16T09:00:00.000Z', notes: null }],
      total: 1,
      averageIntervalDays: null,
    })
    openEdit()
    expect(await screen.findByText(/done once/i)).toBeInTheDocument()
    expect(screen.queryByText(/about every/i)).toBeNull()
  })

  it('stays quiet for a rhythm with no history yet', async () => {
    mockHistory({ completions: [], total: 0, averageIntervalDays: null })
    openEdit()
    await screen.findByRole('dialog')
    expect(screen.queryByText(/done .* times|about every/i)).toBeNull()
  })

  // A scheduling rhythm has no completions by design — asking whether it happened is the
  // question this shape refuses to ask — so it must not even request them.
  it('never asks a scheduling rhythm about completions', async () => {
    mockHistory({ completions: [], total: 0, averageIntervalDays: null })
    openEdit({ ...filter, id: 'r-temple', satisfiedBy: 'scheduling', startsOn: '2026-07-01', nextDueAt: null })
    await screen.findByRole('dialog')
    expect(calls.some((c) => c.url.includes('/completions'))).toBe(false)
  })
})
