import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import mod from './RecapStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 10 · Recap. Almost everything on this screen is a claim ABOUT something else, so
// four things are held in place:
//
//  1. EVERY LINE IS A POINTER — the body computes no tallies of its own, and stores back
//     nothing but the receipt's integers;
//  2. THE SHELL OWNS THE SAVED SCREEN, so the body must not grow a second one;
//  3. a busy day reports the remainder instead of growing past its column;
//  4. the last call on untagged notes, and "left alone on purpose", both survive.
const WEEK_START = '2026-09-06' // a Sunday; the week runs Sun Sep 6 → Sat Sep 12

const Body = mod.Body

const step: PlanningStep = {
  key: 'recap',
  number: 10,
  title: 'Recap',
  ask: 'Here’s the week you just decided.',
  primary: 'Save the week',
  act: 'Close',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  // The shell renders the parked-note handoff, not the step; a step test mounts `Body`
  // alone, so there is never one here.
  parked: [],
}

const day = (i: number, over: Record<string, unknown> = {}) => ({
  date: new Date(Date.parse(`${WEEK_START}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
  meal: null,
  cook: null,
  events: [],
  more: 0,
  ...over,
})

const VIEW = {
  weekStart: WEEK_START,
  savedAt: null,
  days: [
    day(0, { meal: 'Lentil soup', cook: 'Lottie', events: [{ id: 'fn', title: 'Family night', when: 'Sunday 5:00 PM', personName: null }] }),
    day(1, { meal: 'Crockpot chili', cook: 'Kevin' }),
    day(2, { events: [{ id: 'd', title: 'Dance', when: 'Tuesday 4:00 PM', personName: 'Lottie', personId: 'p4', personColor: '#7C3AED', participantIds: ['p4'] }] }),
    day(3),
    day(4),
    day(5, {
      events: [0, 1, 2, 3].map((n) => ({ id: `x${n}`, title: `Thing ${n}`, when: 'Friday 9:00 AM', personName: 'Kevin' })),
      more: 2,
    }),
    day(6, { meal: 'Burgers', cook: 'Kevin' }),
  ],
  groups: [
    {
      key: 'calendar', label: 'Calendar', headline: '2 events added · 9 on the week now',
      detail: 'Date night Saturday 8:00 PM · Doughnuts Friday 7:15 AM', count: 2, stepKey: 'calendar',
    },
    {
      key: 'tasks', label: 'Chores + Rhythms', headline: '6 tasks with an owner and a day',
      detail: 'Furnace filter · Gate latch', count: 6, stepKey: 'tasks',
    },
  ],
  lastCall: [
    { id: 'n1', note: 'Look into summer camps', detail: 'Parked by Kevin · 2 weeks ago · passed over 3 times' },
    { id: 'n2', note: 'Kelly’s parents in October?', detail: 'Parked by Kelly · yesterday' },
  ],
  lastCallMore: 0,
  leftAlone: [
    { key: 'goal:l1', label: "Lottie's goals", detail: '5 goals on the list · no focus needed this week', badge: 'none', stepKey: 'goals' },
    { key: 'skip:connection', label: 'Connection', detail: 'Skipped — a real answer, and nothing here was changed', badge: 'skipped', stepKey: 'connection' },
    { key: 'parked:tasks', label: 'Tasks', detail: '2 notes parked for Tasks — waiting for the next session', badge: 'parked', stepKey: 'tasks' },
  ],
  counts: { decisions: 8, deferred: 3, parked: 4 },
}

const EMPTY = { ...VIEW, groups: [], lastCall: [], leftAlone: [], counts: { decisions: 0, deferred: 0, parked: 0 } }

// Every write is recorded, so "Drop it" is asserted through the request it actually makes
// rather than a canned view replayed back.
function mockApi(view: unknown = VIEW) {
  const calls: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.startsWith('/api/weekly-planning/recap')) return { ok: true, json: async () => view }
    if (u.startsWith('/api/weekly-planning/loose-ends/resolve')) return { ok: true, json: async () => ({ ok: true }) }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
  return calls
}

function renderStep(over: Partial<StepBodyProps> = {}, path = '/planning/recap') {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  render(
    <MemoryRouter initialEntries={[path]}>
      <Body step={step} sessionId="s1" weekStart={WEEK_START} setDecisionData={setDecisionData} refresh={refresh} busy={false} {...over} />
    </MemoryRouter>
  )
  return { setDecisionData, refresh }
}

const dayCell = async (date: string) => (await screen.findByTestId(`wpr-day-${date}`)) as HTMLElement

describe('recap · the week, one last time', () => {
  it('draws seven days in order, each with its dinner and its events', async () => {
    mockApi()
    renderStep()
    const sun = await dayCell('2026-09-06')
    expect(within(sun).getByText(/Lentil soup/)).toBeTruthy()
    expect(within(sun).getByText(/Family night/)).toBeTruthy()
    expect(screen.getAllByTestId(/^wpr-day-/)).toHaveLength(7)
  })

  // Colour is resolved by the SAME `useEventColor()` the month and week views use.
  // Duplicating that rule server-side would drift from the calendar, which is the one
  // thing the strip must agree with.
  it('paints each event in the colour the calendar would give it', async () => {
    mockApi()
    renderStep()
    const tue = await dayCell('2026-09-08')
    const chip = within(tue).getByText('Dance')
    expect(chip.className).toContain('ev-tint')
    expect(chip.getAttribute('style') ?? '').toMatch(/--ev/)
  })

  // The wave-2 lesson: a column that grows past its box paints over what is under it.
  it('holds a busy day back rather than letting the column grow', async () => {
    mockApi()
    renderStep()
    const fri = await dayCell('2026-09-11')
    expect(within(fri).getByText('+2 more')).toBeTruthy()
    expect(within(fri).queryByText(/Thing 4/)).toBeNull()
  })
})

describe('recap · what tonight changed', () => {
  it('groups by the module the decision lives in and names the count the server gave', async () => {
    mockApi()
    renderStep()
    const cal = await screen.findByTestId('wpr-group-calendar')
    expect(within(cal).getByText('Calendar')).toBeTruthy()
    expect(within(cal).getByText(/2 events added/)).toBeTruthy()
    expect(within(cal).getByText(/Date night Saturday 8:00 PM/)).toBeTruthy()
    // The header's number is the server's, never re-added on the client.
    expect(screen.getByText(/8 decisions/)).toBeTruthy()
  })

  it('links each line at the step that owns it, keeping the week in the URL', async () => {
    mockApi()
    renderStep({}, '/planning/recap?week=2026-09-13')
    const cal = await screen.findByTestId('wpr-group-calendar')
    expect(cal.getAttribute('href')).toBe('/planning/calendar?week=2026-09-13')
    const tasks = await screen.findByTestId('wpr-group-tasks')
    expect(tasks.getAttribute('href')).toBe('/planning/tasks?week=2026-09-13')
  })

  it('says plainly that every line is a pointer, not a copy', async () => {
    mockApi()
    renderStep()
    expect(await screen.findByText(/pointer/i)).toBeTruthy()
  })

  it('hands the session record the counts and nothing else', async () => {
    mockApi()
    const { setDecisionData } = renderStep()
    await screen.findByTestId('wpr-group-calendar')
    await waitFor(() =>
      expect(setDecisionData.mock.calls.at(-1)![0]).toEqual({ counts: { decisions: 8, deferred: 3, parked: 4 } })
    )
    // Nothing else: a name frozen on the session record is a copy that goes stale.
    for (const [arg] of setDecisionData.mock.calls) {
      expect(arg === null || Object.keys(arg as object)).toBeTruthy()
      if (arg) expect(Object.keys(arg as object)).toEqual(['counts'])
    }
  })

  // Two screens claiming to be the receipt is the finding this test pins.
  it('does not build a second saved screen — that is the shell’s', async () => {
    mockApi({ ...VIEW, savedAt: '2026-08-30T19:12:00.000Z' })
    renderStep()
    await screen.findByTestId('wpr-group-calendar')
    expect(screen.queryByText(/Reopen the session/i)).toBeNull()
    expect(screen.queryByText(/Start this week over/i)).toBeNull()
  })
})

describe('recap · the last call on what nobody tagged', () => {
  it('lists each note with the history the table can actually prove', async () => {
    mockApi()
    renderStep()
    const row = await screen.findByTestId('wpr-parked-n1')
    expect(within(row).getByText('Look into summer camps')).toBeTruthy()
    expect(within(row).getByText(/passed over 3 times/)).toBeTruthy()
  })

  it('drops a note through the module that owns it, and takes the row away', async () => {
    const calls = mockApi()
    renderStep()
    const row = await screen.findByTestId('wpr-parked-n1')
    fireEvent.click(within(row).getByText('Drop it'))
    await waitFor(() => expect(screen.queryByTestId('wpr-parked-n1')).toBeNull())
    const post = calls.find((c) => c.url.includes('loose-ends/resolve'))!
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({ kind: 'parked', id: 'n1', action: 'drop', sessionId: 's1' })
  })

  it('keeps a note parked without writing anything — it is still open next Sunday', async () => {
    const calls = mockApi()
    renderStep()
    const row = await screen.findByTestId('wpr-parked-n2')
    fireEvent.click(within(row).getByText('Keep it parked'))
    await waitFor(() => expect(screen.queryByTestId('wpr-parked-n2')).toBeNull())
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})

describe('recap · left alone on purpose', () => {
  it('renders a skipped step and a deliberate non-answer as outcomes, not gaps', async () => {
    mockApi()
    renderStep()
    const skipped = await screen.findByTestId('wpr-alone-skip:connection')
    expect(within(skipped).getByText('skipped')).toBeTruthy()
    const none = await screen.findByTestId('wpr-alone-goal:l1')
    expect(within(none).getByText("Lottie's goals")).toBeTruthy()
    expect(within(none).getByText(/no focus needed/)).toBeTruthy()
    const parked = await screen.findByTestId('wpr-alone-parked:tasks')
    expect(within(parked).getByText(/parked for Tasks/)).toBeTruthy()
  })
})

describe('recap · a session that decided nothing', () => {
  it('says so rather than drawing empty cards full of zeros', async () => {
    mockApi(EMPTY)
    renderStep()
    expect(await screen.findByText(/Nothing was decided/i)).toBeTruthy()
    expect(screen.queryByTestId('wpr-group-calendar')).toBeNull()
    expect(screen.getAllByTestId(/^wpr-day-/)).toHaveLength(7)
  })
})
