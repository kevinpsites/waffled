import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './FamilyNightStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'

// Step 4 · Family night — "Accept the rotation, or change it?"
//
// What this file guards: a pin goes to the OCCURRENCE, never to the household config (so it
// watches for a config PUT that must never happen); every write is the familyNight module's
// own endpoint; and calling the week off touches no event. The fetch double is stateful
// because what the screen shows after a pin has to be the RE-READ.

const { Body } = mod
// The footer control is this step's, so the tests render it beside the body as the shell does.
const FooterExtra = mod.FooterExtra!

const step: PlanningStep = {
  key: 'familyNight',
  number: 4,
  title: 'Family night',
  ask: 'Accept the rotation, or change it?',
  primary: 'Accept',
  act: 'Claim the good',
  requiresModule: 'familyNight',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  // The shell renders the parked-note handoff, not the step, and a step test mounts `Body`.
  parked: [],
}

const WEEK = '2026-09-06' // a Sunday
const DATE = '2026-09-09' // the Wednesday inside it

const MEMBERS = [
  { id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#7A5AF8' },
  { id: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#E0653F' },
  { id: 'p3', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368' },
  { id: 'p4', name: 'Lottie', avatarEmoji: '🦄', colorHex: '#C2410C' },
]

interface Part {
  partId: string; label: string; emoji: string; rotates: boolean
  detail: string | null
  personId: string | null; personName: string | null; pinned: boolean
}
interface Board {
  weekStart: string; date: string; dayOfWeek: number; time: string
  occurrenceId: string | null; theme: string | null; status: string
  // `onCalendar` is the STANDING weekly series; `eventId` is what THIS week points at.
  onCalendar: boolean
  eventId: string | null; eventTitle: string | null; eventWhen: string | null
  members: typeof MEMBERS; parts: Part[]
}

const BOARD: Board = {
  weekStart: WEEK,
  date: DATE,
  dayOfWeek: 3,
  time: '17:00',
  occurrenceId: null,
  theme: null,
  status: 'planned',
  onCalendar: true,
  eventId: null,
  eventTitle: null,
  eventWhen: null,
  members: MEMBERS,
  parts: [
    { partId: 'activity', label: 'Activity', emoji: '🎲', rotates: true, detail: null, personId: 'p3', personName: 'Wally', pinned: false },
    { partId: 'treat', label: 'Treat', emoji: '🍪', rotates: true, detail: null, personId: 'p4', personName: 'Lottie', pinned: false },
    { partId: 'checkin', label: 'Check-in', emoji: '💬', rotates: true, detail: null, personId: 'p2', personName: 'Kelly', pinned: false },
  ],
}

let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

function mockApi(over: Partial<Board> = {}) {
  calls = []
  const state = { ...JSON.parse(JSON.stringify(BOARD)), ...JSON.parse(JSON.stringify(over)) } as Board
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/weekly-planning/familyNight')) {
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    }
    // The module's own upsert — the ONLY write this step makes, modelled the way the server
    // behaves: a partial assignment list writes only the parts named, and only '' clears a theme.
    if (u.includes('/api/family-night/occurrence') && method === 'POST') {
      const b = (body ?? {}) as {
        date?: string; theme?: string | null; status?: string
        eventId?: string | null; createEvent?: boolean
        assignments?: { partId: string; personId?: string | null; detail?: string | null }[]
      }
      state.occurrenceId = state.occurrenceId ?? 'occ1'
      if (typeof b.theme === 'string') state.theme = b.theme || null
      if (b.status) state.status = b.status
      // PRESENCE, exactly as the server reads it: a key that wasn't sent isn't written. The
      // mock has to model it, or a detail-only write that un-assigns somebody goes unseen.
      if ('eventId' in b) {
        state.eventId = b.eventId ?? null
        state.eventTitle = b.eventId ? '🍿 Movie night' : null
        state.eventWhen = b.eventId ? 'Friday 7:00 PM' : null
      } else if (b.createEvent === true && !state.eventId) {
        state.eventId = 'ev-made'
        state.eventTitle = state.theme ? `🏡 ${state.theme}` : '🏡 Family Night'
        state.eventWhen = 'Wednesday 5:00 PM'
      }
      for (const a of b.assignments ?? []) {
        const part = state.parts.find((p) => p.partId === a.partId)
        if (!part) continue
        if ('personId' in a) {
          part.personId = a.personId ?? null
          part.personName = MEMBERS.find((m) => m.id === a.personId)?.name ?? null
          part.pinned = true
        }
        if ('detail' in a) part.detail = a.detail?.trim() ? a.detail.trim() : null
      }
      return { ok: true, json: async () => ({ id: state.occurrenceId }) }
    }
    // Only reached once somebody opens the picker; the step itself touches no event endpoint.
    if (u.includes('/api/events')) {
      return {
        ok: true,
        json: async () => ({
          events: [
            { id: 'ev-movie', title: '🍿 Movie night', startsAt: `${DATE}T19:00:00Z`, endsAt: null, allDay: false, origin: 'manual', personId: null, personColor: null, participants: [] },
            { id: 'ev-dinner', title: 'Spaghetti', startsAt: `${DATE}T18:00:00Z`, endsAt: null, allDay: false, origin: 'meal_plan', personId: null, personColor: null, participants: [] },
          ],
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return state
}

// The store is module-scoped and outlives a render, so a fresh session id starts each clean.
let seq = 0
const props = (over: Partial<StepBodyProps> = {}): StepBodyProps => ({
  step,
  sessionId: `s-${++seq}`,
  weekStart: WEEK,
  setDecisionData: vi.fn(),
  refresh: vi.fn(),
  busy: false,
  ...over,
})

const row = (label: string) => screen.getByTestId(`wpfn-row-${label}`)
const wrote = (match: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(match))
const face = (label: string, name: string) => within(row(label)).getByRole('button', { name: new RegExp(name) })

describe('FamilyNightStep', () => {
  it('is three rows and a theme line: the night, and who the rotation suggests', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    expect(screen.getByText(/every Wednesday/i)).toBeTruthy()
    expect(screen.getByText(/Wednesday, Sep 9/)).toBeTruthy()
    expect(screen.getByText(/5:00 PM/)).toBeTruthy()

    expect(within(row('Activity')).getByText(/suggested/i).textContent).toMatch(/Wally/)
    expect(within(row('Treat')).getByText(/suggested/i).textContent).toMatch(/Lottie/)
    expect(within(row('Check-in')).getByText(/suggested/i).textContent).toMatch(/Kelly/)

    expect(wrote('/api/family-night')).toHaveLength(0)
  })

  it('says "nobody yet" for a part the rotation has no one for', async () => {
    mockApi({
      parts: [
        { partId: 'activity', label: 'Activity', emoji: '🎲', rotates: true, detail: null, personId: 'p3', personName: 'Wally', pinned: false },
        { partId: 'treat', label: 'Treat', emoji: '🍪', rotates: true, detail: null, personId: 'p4', personName: 'Lottie', pinned: false },
        // A fixed part (rotates: false) is never auto-filled — but it still takes a pin.
        { partId: 'checkin', label: 'Check-in', emoji: '💬', rotates: false, detail: null, personId: null, personName: null, pinned: false },
      ],
    })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Check-in/)).toBeTruthy())
    expect(within(row('Check-in')).getByText(/nobody yet/i)).toBeTruthy()
    expect(within(row('Check-in')).getByRole('button', { name: /Wally/ })).toBeTruthy()
  })

  it('pins a face for this week — on the occurrence, never on the household config', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    fireEvent.click(face('Activity', 'Lottie'))
    await waitFor(() => expect(within(row('Activity')).getByText(/pinned for this week/i)).toBeTruthy())
    expect(within(row('Activity')).getByText(/pinned for this week/i).textContent).toMatch(/Lottie/)

    // ONE write, the module's own occurrence endpoint keyed by the DATE — the whole of
    // "pinned for this week only".
    const posts = wrote('/api/family-night/occurrence')
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ date: DATE, assignments: [{ partId: 'activity', personId: 'p4' }] })

    // The config is the household's standing agenda. A pin must never reach it.
    expect(calls.some((c) => c.url.includes('/api/family-night/config'))).toBe(false)
    expect(calls.every((c) => c.method !== 'PUT')).toBe(true)

    expect(within(row('Treat')).getByText(/suggested/i)).toBeTruthy()
    expect(within(row('Check-in')).getByText(/suggested/i)).toBeTruthy()
  })

  it('re-reads the board after a pin rather than trusting its own bookkeeping', async () => {
    mockApi()
    const refresh = vi.fn()
    render(<Body {...props({ refresh })} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    const readsBefore = calls.filter((c) => c.url.includes('/api/weekly-planning/familyNight')).length

    fireEvent.click(face('Treat', 'Kevin'))
    await waitFor(() => expect(within(row('Treat')).getByText(/pinned/i)).toBeTruthy())
    expect(calls.filter((c) => c.url.includes('/api/weekly-planning/familyNight')).length).toBeGreaterThan(readsBefore)
    expect(refresh).toHaveBeenCalled()
  })

  it('keeps a free-text theme on the night, and can take it back off', async () => {
    mockApi()
    render(<Body {...props()} />)
    const theme = await screen.findByLabelText(/theme/i)
    expect((theme as HTMLInputElement).placeholder).toMatch(/pizza and the new Lego set/i)

    fireEvent.change(theme, { target: { value: 'Pizza and the new Lego set' } })
    fireEvent.blur(theme)
    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, theme: 'Pizza and the new Lego set' })

    // Clearing sends '' rather than null: the server reads a null theme as "leave it alone".
    fireEvent.change(theme, { target: { value: '' } })
    fireEvent.blur(theme)
    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(2))
    expect(wrote('/api/family-night/occurrence')[1].body).toEqual({ date: DATE, theme: '' })
  })

  it('does not re-save a theme nobody changed', async () => {
    mockApi({ theme: 'Pizza and the new Lego set' })
    render(<Body {...props()} />)
    const theme = await screen.findByLabelText(/theme/i)
    fireEvent.focus(theme)
    fireEvent.blur(theme)
    expect(wrote('/api/family-night/occurrence')).toHaveLength(0)
  })

  it('calls the week off from the footer: a status on the night, and nothing else', async () => {
    mockApi()
    const p = props()
    render(<><Body {...p} /><FooterExtra {...p} /></>)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Skip this week/i }))
    await waitFor(() => expect(screen.getByText(/Skipped this week/i)).toBeTruthy())

    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, status: 'skipped' })
    expect(calls.some((c) => c.url.includes('/api/events'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/api/family-night/schedule'))).toBe(false)

    expect(screen.queryByRole('button', { name: /Skip this week/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Undo/i }))
    await waitFor(() => expect(screen.queryByText(/Skipped this week/i)).toBeNull())
    expect(wrote('/api/family-night/occurrence')[1].body).toEqual({ date: DATE, status: 'planned' })
  })

  it('only promises the calendar event is untouched when there IS one', async () => {
    mockApi({ status: 'skipped', occurrenceId: 'occ1', onCalendar: false })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Skipped this week/i)).toBeTruthy())
    expect(screen.queryByText(/calendar event/i)).toBeNull()
  })

  it('hands the session a crumb of what it decided, not a copy of the module', async () => {
    mockApi()
    const setDecisionData = vi.fn()
    render(<Body {...props({ setDecisionData })} />)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    expect(setDecisionData).toHaveBeenCalledWith({ pinned: [], skipped: false })

    fireEvent.click(face('Activity', 'Lottie'))
    await waitFor(() => expect(setDecisionData).toHaveBeenCalledWith({ pinned: ['activity'], skipped: false }))
  })

  it('freezes its own controls while the shell has a write in flight', async () => {
    mockApi()
    const p = props({ busy: true })
    render(<><Body {...p} /><FooterExtra {...p} /></>)
    await waitFor(() => expect(screen.getByText(/Activity/)).toBeTruthy())
    expect((face('Activity', 'Lottie') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Skip this week/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('FamilyNightStep · what each part actually is', () => {
  it('saves a part’s detail on blur WITHOUT touching who has it', async () => {
    mockApi()
    render(<Body {...props()} />)
    const box = await screen.findByLabelText(/what is the treat/i)
    fireEvent.change(box, { target: { value: 'The good ice cream' } })
    fireEvent.blur(box)

    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    const body = wrote('/api/family-night/occurrence')[0].body as {
      assignments: { partId: string; detail: string; personId?: unknown }[]
    }
    expect(body.assignments[0]).toEqual({ partId: 'treat', detail: 'The good ice cream' })
    // THE POINT: no `personId` key at all. The server reads presence, so including it —
    // even as null — would turn "I named the treat" into "…and nobody has it".
    expect('personId' in body.assignments[0]).toBe(false)
  })

  it('leaves the rotation’s suggestion standing after a detail is written', async () => {
    mockApi()
    render(<Body {...props()} />)
    const box = await screen.findByLabelText(/what is the activity/i)
    fireEvent.change(box, { target: { value: 'Charades' } })
    fireEvent.blur(box)

    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    // Naming the activity said nothing about whose turn it is, so the row above may not move.
    const row = await screen.findByTestId('wpfn-row-Activity')
    await waitFor(() => expect(row.textContent).toMatch(/suggested/i))
    expect(row.textContent).toMatch(/Wally/)
  })

  it('does not write while the value is unchanged', async () => {
    mockApi({ parts: [{ ...BOARD.parts[0], detail: 'Charades' }, BOARD.parts[1], BOARD.parts[2]] })
    render(<Body {...props()} />)
    const box = await screen.findByLabelText(/what is the activity/i)
    expect((box as HTMLInputElement).value).toBe('Charades')
    fireEvent.blur(box)
    expect(wrote('/api/family-night/occurrence')).toHaveLength(0)
  })
})

describe('FamilyNightStep · this week on the calendar', () => {
  it('adds this week to the calendar in one call, without an event form', async () => {
    mockApi()
    render(<Body {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /add to calendar/i }))

    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, createEvent: true })
    // Created SERVER-side and linked in the same call: the web writes events locally first,
    // so a client id may not exist server-side yet.
    await waitFor(() => expect(screen.getByTestId('wpfn-cal').textContent).toMatch(/on the calendar for this week/i))
  })

  it('points the week at an event it already has, and skips meal mirrors', async () => {
    mockApi()
    render(<Body {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /link an event/i }))

    const list = await screen.findByLabelText(/events on this week/i)
    expect(list.textContent).toMatch(/Movie night/)
    // A planned dinner is not a family night — offering one puts a meal where an evening goes.
    expect(list.textContent).not.toMatch(/Spaghetti/)

    fireEvent.click(screen.getByRole('button', { name: /Movie night/ }))
    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, eventId: 'ev-movie' })
  })

  it('unlinks without deleting the event', async () => {
    mockApi({ eventId: 'ev-movie', eventTitle: '🍿 Movie night', eventWhen: 'Friday 7:00 PM' })
    render(<Body {...props()} />)
    fireEvent.click(await screen.findByRole('button', { name: /unlink/i }))

    await waitFor(() => expect(wrote('/api/family-night/occurrence')).toHaveLength(1))
    expect(wrote('/api/family-night/occurrence')[0].body).toEqual({ date: DATE, eventId: null })
    // No DELETE near the calendar: "this isn't family night" must not delete Friday.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('keeps the standing weekly series and this week’s event apart', async () => {
    // `onCalendar` true, `eventId` null — the recurring event exists but nothing was said
    // about THIS week. Reading the two as one thing is how this screen goes wrong.
    mockApi({ onCalendar: true, eventId: null })
    render(<Body {...props()} />)
    const cal = await screen.findByTestId('wpfn-cal')
    expect(cal.textContent).toMatch(/not on the calendar this week/i)
    expect(cal.textContent).toMatch(/standing weekly event still stands/i)
  })
})
