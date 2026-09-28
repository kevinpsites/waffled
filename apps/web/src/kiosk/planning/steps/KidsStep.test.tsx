import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './KidsStep'
import type { StepBodyProps } from '../registry'

// Step 9 · Kids — "What's your week about?"
//
// THE ONE STEP THE KIDS THEMSELVES READ, so what is asserted is what a nine-year-old can
// see and do: both cards on one screen with the kid's own NAME as the heading; every
// option drawn from something that already exists, with "＋ Something else" last; and
// once both questions are answered, the step flips to the READ-BACK. The fetch double is
// stateful, so what's asserted is the reaction to the server's answer, not to a guess.

const goal = (over: Record<string, unknown> = {}) => ({
  id: 'g-read',
  goalListId: 'l-kids',
  title: 'Read 20 minutes a day',
  emoji: '📖',
  category: null,
  goalType: 'habit',
  unit: null,
  habitPeriod: 'week',
  habitTargetPerPeriod: 5,
  trackingMode: 'each_tracks',
  participantMode: 'count_once',
  targetBasis: 'family',
  logMethod: 'quick_log',
  autoFromCalendar: false,
  deadline: null,
  isFeatured: false,
  isSpotlight: false,
  hasRewards: false,
  target: null,
  // A habit is shown on THIS period's count — the lifetime 99 must never be what the card
  // says, which is exactly what the shared display helper is for.
  totalProgress: 99,
  milestoneTotal: 0,
  milestoneReached: 0,
  periodDone: 2,
  stepTotal: 0,
  stepDone: 0,
  streakDays: 0,
  loggedTodayBy: [],
  participants: [],
  ...over,
})

const wally = () => ({
  personId: 'p-wally',
  name: 'Wally',
  avatarEmoji: '🐢',
  colorHex: '#25A368',
  age: 9,
  stars: 24 as number | null,
  starsSymbol: '⭐' as string | null,
  week: [
    { id: 'e-soccer', title: 'Soccer game', when: 'Tue 4:00 PM', startsAt: '2026-09-08T21:00:00.000Z', allDay: false },
    { id: 'e-scouts', title: 'Scouts', when: 'Wed 6:00 PM', startsAt: '2026-09-09T23:00:00.000Z', allDay: false },
  ],
  chores: [
    { id: 'c-homework', title: 'Homework before screens', emoji: '🎒', when: 'Mon, Tue, Wed, Thu, Fri', late: false },
    { id: 'c-garage', title: 'Get the garage done', emoji: '🧹', when: 'open since Wednesday', late: true },
  ],
  focusOptions: [
    { key: 'goal:g-read', source: 'goal', id: 'g-read', emoji: '📖', label: 'Read 20 minutes a day', detail: '2 of 5 this week', routed: false, goal: goal() },
    { key: 'chore:c-garage', source: 'chore', id: 'c-garage', emoji: '🧹', label: 'Get the garage done', detail: 'open since Wednesday', routed: true, goal: null },
    { key: 'chore:c-homework', source: 'routine', id: 'c-homework', emoji: '🎒', label: 'Homework before screens', detail: null, routed: false, goal: null },
  ],
  forwardOptions: [
    { key: 'event:e-soccer', eventId: 'e-soccer', emoji: '📅', label: 'Soccer game', when: 'Tue' },
    { key: 'event:e-scouts', eventId: 'e-scouts', emoji: '📅', label: 'Scouts', when: 'Wed' },
  ],
  focus: null as Record<string, unknown> | null,
  forward: null as Record<string, unknown> | null,
  settled: false,
})

const lottie = () => ({
  personId: 'p-lottie',
  name: 'Lottie',
  avatarEmoji: '🦄',
  colorHex: '#C86A4B',
  age: 6,
  stars: 31 as number | null,
  starsSymbol: '⭐' as string | null,
  week: [{ id: 'e-party', title: 'Birthday party', when: 'Sat 10:00 AM', startsAt: '2026-09-12T15:00:00.000Z', allDay: false }],
  chores: [{ id: 'c-vacuum', title: 'Vacuum upstairs', emoji: '🧺', when: 'Sat', late: false }],
  focusOptions: [
    { key: 'goal:g-recital', source: 'goal', id: 'g-recital', emoji: '💃', label: 'Practice for the recital', detail: '3 of 20 sessions', routed: false, goal: goal({ id: 'g-recital', title: 'Practice for the recital', goalType: 'count', unit: 'sessions', target: 20, totalProgress: 3, periodDone: 0, habitPeriod: null, habitTargetPerPeriod: null }) },
    { key: 'chore:c-vacuum', source: 'routine', id: 'c-vacuum', emoji: '🧺', label: 'Vacuum upstairs', detail: null, routed: false, goal: null },
  ],
  forwardOptions: [{ key: 'event:e-party', eventId: 'e-party', emoji: '🎉', label: 'Birthday party', when: 'Sat' }],
  focus: null as Record<string, unknown> | null,
  forward: null as Record<string, unknown> | null,
  settled: false,
})

const VIEW = () => ({
  weekStart: '2026-09-06',
  kids: [wally(), lottie()],
  sources: { goals: true, chores: true, rewards: true },
  canRepeat: true,
})

type View = ReturnType<typeof VIEW>
const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// The double behaves like the server: an answer is resolved against the card's own options,
// stored, and echoed back — including `settled`, which flips the step to its read-back.
function mockApi(view: View = VIEW()) {
  calls.length = 0
  const state = JSON.parse(JSON.stringify(view)) as View
  const settle = (k: View['kids'][number]) => { k.settled = k.focus != null && k.forward != null }
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })
    if (u.includes('/api/weekly-planning/kids/answer')) {
      const k = state.kids.find((x) => x.personId === body.personId)!
      if (body.focus !== undefined) {
        k.focus = body.focus == null
          ? null
          : 'text' in body.focus
            ? { source: 'custom', id: null, emoji: '✨', label: body.focus.text, detail: null }
            : (() => { const o = k.focusOptions.find((x) => x.key === body.focus.key)!; return { source: o.source, id: o.id, emoji: o.emoji, label: o.label, detail: o.detail } })()
      }
      if (body.forward !== undefined) {
        k.forward = body.forward == null
          ? null
          : 'text' in body.forward
            ? { eventId: null, emoji: '✨', label: body.forward.text, when: '' }
            : (() => { const o = k.forwardOptions.find((x) => x.key === body.forward.key)!; return { eventId: o.eventId, emoji: o.emoji, label: o.label, when: o.when } })()
      }
      settle(k)
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    }
    if (u.includes('/api/weekly-planning/kids/repeat')) {
      for (const k of state.kids) {
        const o = k.focusOptions[0]
        k.focus = { source: o.source, id: o.id, emoji: o.emoji, label: o.label, detail: o.detail }
        const f = k.forwardOptions[0]
        k.forward = { eventId: f.eventId, emoji: f.emoji, label: f.label, when: f.when }
        settle(k)
      }
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
  }) as unknown as typeof fetch
  return state
}

const step = {
  key: 'kids', number: 9, title: 'Kids', ask: 'What’s your week about?',
  primary: 'Done', act: 'Run the household',
  available: true, status: 'pending' as const, data: {}, decidedAt: null,
  // The shell renders the parked-note handoff, not the step, and a step test mounts `Body`
  // alone — see TasksStep.test.tsx.
  parked: [],
}

// A fresh session id per render: the step keeps its state in a module-scoped store (Body
// and FooterExtra are sibling trees), so a shared key would carry answers across tests.
let seq = 0
function renderStep(over: Partial<StepBodyProps> = {}) {
  const setDecisionData = vi.fn()
  const refresh = vi.fn()
  const props: StepBodyProps = {
    step, sessionId: `s${++seq}`, weekStart: '2026-09-06',
    setDecisionData, refresh, busy: false, ...over,
  }
  const utils = render(<mod.Body {...props} />)
  return { setDecisionData, refresh, props, utils }
}

const card = async (name: string) => {
  const el = await screen.findByRole('group', { name: new RegExp(name) })
  return within(el)
}

beforeEach(() => { mockApi() })

describe('KidsStep · both kids on one screen', () => {
  it('gives each kid a card headed with their own name, not the step title', async () => {
    renderStep()
    expect(await screen.findByRole('heading', { name: /Wally and Lottie/ })).toBeTruthy()
    expect((await card('Wally')).getByText('Wally')).toBeTruthy()
    expect((await card('Lottie')).getByText('Lottie')).toBeTruthy()
  })

  it('shows each kid their own week, their own chores and their own stars', async () => {
    renderStep()
    const w = await card('Wally')
    const wk = within(w.getByRole('list', { name: /Wally.s week/ }))
    expect(wk.getByText('Soccer game')).toBeTruthy()
    expect(wk.getByText('Homework before screens')).toBeTruthy()
    expect(wk.getByText('Get the garage done')).toBeTruthy()
    expect(w.getByText(/24/)).toBeTruthy()

    const l = await card('Lottie')
    expect(within(l.getByRole('list', { name: /Lottie.s week/ })).getByText('Birthday party')).toBeTruthy()
    expect(l.queryByText('Soccer game')).toBeNull()
    expect(l.getByText(/31/)).toBeTruthy()
  })

  it('reads a goal option on the goal’s OWN axis, through the shared helper', async () => {
    renderStep()
    const w = await card('Wally')
    const opt = w.getByRole('radio', { name: /Read 20 minutes a day/ })
    // 2 of 5 THIS WEEK. The lifetime 99 is in the fixture precisely so an inline
    // `totalProgress` would show up here and fail.
    expect(within(opt).getByText('2')).toBeTruthy()
    expect(within(opt).queryByText('99')).toBeNull()
    expect(within(opt).getByText(/2 of 5 this week/)).toBeTruthy()
  })

  it('says which option step 1 sent here, and keeps the server’s order', async () => {
    renderStep()
    const w = await card('Wally')
    const options = within(w.getByRole('radiogroup', { name: /one thing/i })).getAllByRole('radio')
    // The promotion is the SERVER's; the card renders the order it was given rather than
    // re-deciding it, so a second, drifting sort can't grow here.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Read 20 minutes a day'),
      expect.stringContaining('Get the garage done'),
      expect.stringContaining('Homework before screens'),
      expect.stringContaining('Something else'),
    ])
    expect(w.getByRole('radio', { name: /Get the garage done/ }).textContent).toMatch(/step 1/i)
  })

  it('offers "＋ Something else" as the LAST resort, never the first', async () => {
    renderStep()
    const w = await card('Wally')
    const options = within(w.getByRole('radiogroup', { name: /one thing/i })).getAllByRole('radio')
    expect(options[options.length - 1].textContent).toContain('Something else')
    expect(options.filter((o) => o.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  })
})

describe('KidsStep · answering', () => {
  it('records a focus and a thing to look forward to, from the real options', async () => {
    renderStep()
    const w = await card('Wally')
    fireEvent.click(w.getByRole('radio', { name: /Read 20 minutes a day/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const put = calls.filter((c) => c.method === 'PUT')[0]
    expect(put.body).toMatchObject({ personId: 'p-wally', focus: { key: 'goal:g-read' } })

    fireEvent.click((await card('Wally')).getByRole('radio', { name: /Soccer game/ }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2))
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ forward: { key: 'event:e-soccer' } })
  })

  it('takes free text through the escape hatch', async () => {
    renderStep()
    const w = await card('Wally')
    fireEvent.click(w.getByRole('radio', { name: /Something else/ }))
    const input = await screen.findByLabelText(/something else/i)
    fireEvent.change(input, { target: { value: 'Be kind to Lottie' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.filter((c) => c.method === 'PUT')[0].body).toMatchObject({ focus: { text: 'Be kind to Lottie' } })
  })

  it('shows a chosen custom answer as CHOSEN, not as the escape hatch', async () => {
    renderStep()
    const w = await card('Wally')
    fireEvent.click(w.getByRole('radio', { name: /Something else/ }))
    const input = await screen.findByLabelText(/something else/i)
    fireEvent.change(input, { target: { value: 'Extra Thing' } })
    fireEvent.submit(input.closest('form')!)

    const chosen = await waitFor(() => w.getByRole('radio', { name: /Extra Thing/ }))
    expect(chosen.getAttribute('aria-checked')).toBe('true')
    expect(chosen.className).toContain('on')
    // `.wpk-opt.more` is declared AFTER `.wpk-opt.on` at equal specificity, so as long as
    // the answered chip still carries `more` the cascade paints it dashed and grey.
    expect(chosen.className).not.toContain('more')
  })

  it('reopens a chosen custom answer with what they said, not an empty box', async () => {
    renderStep()
    const w = await card('Wally')
    fireEvent.click(w.getByRole('radio', { name: /Something else/ }))
    const first = await screen.findByLabelText(/something else/i)
    fireEvent.change(first, { target: { value: 'Extra Thing' } })
    fireEvent.submit(first.closest('form')!)
    await waitFor(() => expect(w.getByRole('radio', { name: /Extra Thing/ })).toBeTruthy())

    fireEvent.click(w.getByRole('radio', { name: /Extra Thing/ }))
    const again = await screen.findByLabelText(/something else/i)
    expect((again as HTMLInputElement).value).toBe('Extra Thing')
  })

  it('keeps an unsaved draft when they change their mind and pick an existing option', async () => {
    // Changing your answer SHOULD change your answer, but the typing must not be thrown
    // away: it is saved nowhere else, so going back for it is the only way to get it.
    renderStep()
    const w = await card('Wally')
    fireEvent.click(w.getByRole('radio', { name: /Something else/ }))
    const typed = await screen.findByLabelText(/something else/i)
    fireEvent.change(typed, { target: { value: 'Build the treehouse' } })

    const existing = w.getAllByRole('radio')[0]
    fireEvent.click(existing)
    await waitFor(() => expect(existing).toHaveAttribute('aria-checked', 'true'))

    expect(w.getByRole('radio', { name: /Something else/ })).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(w.getByRole('radio', { name: /Something else/ }))
    const reopened = await screen.findByLabelText(/something else/i)
    expect((reopened as HTMLInputElement).value).toBe('Build the treehouse')
  })

  it('mirrors what the session already knows onto the step’s crumb', async () => {
    const { setDecisionData } = renderStep()
    await waitFor(() => expect(setDecisionData).toHaveBeenCalled())
    fireEvent.click((await card('Wally')).getByRole('radio', { name: /Read 20 minutes a day/ }))
    await waitFor(() => {
      const last = setDecisionData.mock.calls.at(-1)![0] as { kids: Record<string, { focus: { label: string } | null }> }
      expect(last.kids['p-wally'].focus!.label).toBe('Read 20 minutes a day')
    })
  })

  it('disables the picker while the shell has a write in flight', async () => {
    renderStep({ busy: true })
    const w = await card('Wally')
    expect(w.getByRole('radio', { name: /Read 20 minutes a day/ }).hasAttribute('disabled')).toBe(true)
  })
})

describe('KidsStep · the read-back', () => {
  // The design calls the second frame "the part they'll actually remember", so it gets real
  // weight: the same card, settled, in large type — not a status line under a live picker.
  const answered = () => {
    const v = VIEW()
    for (const k of v.kids) {
      const o = k.focusOptions[0]
      k.focus = { source: o.source, id: o.id, emoji: o.emoji, label: o.label, detail: o.detail }
      const f = k.forwardOptions[0]
      k.forward = { eventId: f.eventId, emoji: f.emoji, label: f.label, when: f.when }
      k.settled = true
    }
    return v
  }

  it('reads both answers back once every card is settled', async () => {
    mockApi(answered())
    renderStep()
    const w = await card('Wally')
    const said = within(w.getByRole('region', { name: /What Wally said/ }))
    expect(said.getByText('Read 20 minutes a day')).toBeTruthy()
    expect(said.getByText(/this week.s one thing/i)).toBeTruthy()
    expect(said.getByText('Soccer game')).toBeTruthy()
    expect(said.getByText(/look forward to/i)).toBeTruthy()
    expect(w.queryAllByRole('radio')).toHaveLength(0)
  })

  it('stays on the picker while one card is only half answered', async () => {
    const v = answered()
    v.kids[1].forward = null
    v.kids[1].settled = false
    mockApi(v)
    renderStep()
    expect((await card('Lottie')).getAllByRole('radio').length).toBeGreaterThan(0)
  })

  it('the footer offers "Change something" on the read-back, and takes you back', async () => {
    mockApi(answered())
    const { props } = renderStep()
    const Extra = mod.FooterExtra!
    render(<Extra {...props} />)
    const back = await screen.findByRole('button', { name: /change something/i })
    fireEvent.click(back)
    await waitFor(async () => expect((await card('Wally')).queryAllByRole('radio').length).toBeGreaterThan(0))
  })

  it('the footer offers "Same as last week" while the cards are still open', async () => {
    const { props } = renderStep()
    const Extra = mod.FooterExtra!
    render(<Extra {...props} />)
    const btn = await screen.findByRole('button', { name: /same as last week/i })
    fireEvent.click(btn)
    await waitFor(() => expect(calls.some((c) => c.url.includes('/kids/repeat'))).toBe(true))
  })
})

describe('KidsStep · honest empty states', () => {
  it('says so when the household has no children rather than showing a blank step', async () => {
    mockApi({ ...VIEW(), kids: [], canRepeat: false })
    renderStep()
    expect(await screen.findByText(/no (one|children|kids)/i)).toBeTruthy()
  })

  it('never claims to have read a module that is off', async () => {
    const v = VIEW()
    v.sources.goals = false
    v.sources.rewards = false
    for (const k of v.kids) {
      k.focusOptions = k.focusOptions.filter((o) => o.source !== 'goal')
      k.stars = null
      k.starsSymbol = null
    }
    mockApi(v)
    renderStep()
    const w = await card('Wally')
    expect(w.queryByText(/Read 20 minutes a day/)).toBeNull()
    expect(w.queryByText(/24/)).toBeNull()
  })
})
