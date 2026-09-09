import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mod from './TasksStep'
import type { PlanningStep } from '../../../lib/api'
import type { StepBodyProps } from '../registry'
import { HandoffCtx, type HandoffAction } from '../handoff'

// Step 8 · Tasks — "Who's doing what?"
//
// The board is the kiosk Chores layout, and each column shows what that person is CARRYING
// for the week FROM THE SERVER READ — so a hand-out only shows up because the board was
// re-read. Every move is reversible, by tap or by drag, and both directions carry every
// open day of the chore or the two boards disagree. Drag is the kiosk board's own
// pointer-event mechanism: grip pointerdown → pointermove over a column → pointerup.

const { Body } = mod

const step: PlanningStep = {
  key: 'tasks',
  number: 8,
  title: 'Tasks',
  ask: 'Who’s doing what?',
  primary: 'Handed out',
  act: 'Run the household',
  requiresModule: 'chores',
  available: true,
  status: 'pending',
  data: {},
  decidedAt: null,
  // The shell renders the parked-note handoff, not the step, so a `Body` mount has none.
  parked: [],
}

const WEEK = '2026-09-06' // a Sunday; 09-09 is Wed, 09-12 is Sat

// THE CLOCK IS PART OF THE FIXTURE, because `WEEK` is. The server floors the plannable
// week at the household's CURRENT one, so a hard-coded week left to the real clock stops
// being reachable once its Sunday goes by — and the suite starts failing with no source
// change. Only `Date` is faked; the timers stay real so `waitFor` behaves as before.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-03T12:00:00Z')) // the Thursday before WEEK
})
afterEach(() => { vi.useRealTimers() })
interface Card {
  id: string; title: string; emoji: string | null; rrule: string | null; cadence: string
  days: string[]; dueOn: string | null; dueTime: string | null; carriedOver: boolean
  rewardAmount: number; rewardCurrency: string; pendingInstanceIds: string[]
  requiresApproval: boolean; requiresPhoto: boolean
}
const chore = (over: Partial<Card> & { id: string; title: string }): Card => ({
  emoji: null, rrule: null, cadence: 'once', days: [], dueOn: null, dueTime: null,
  carriedOver: false, rewardAmount: 0, rewardCurrency: 'stars', pendingInstanceIds: [],
  requiresApproval: false, requiresPhoto: false,
  ...over,
})

const BOARD = {
  weekStart: WEEK,
  // Inside the week being planned, never whatever day the board was opened on.
  newTaskDay: WEEK,
  people: [
    {
      id: 'p1', name: 'Kevin', avatarEmoji: '🧔', colorHex: '#7A5AF8', memberType: 'adult', isAdmin: true,
      recurringChores: 4,
      chores: [chore({ id: 'k1', title: 'Dishes', cadence: 'daily', rrule: 'FREQ=DAILY', days: ['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'], pendingInstanceIds: ['i7', 'i8'] })],
    },
    {
      id: 'p2', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false,
      recurringChores: 1,
      chores: [chore({ id: 'w1', title: 'Vacuum upstairs', cadence: 'weekly', rrule: 'FREQ=WEEKLY;BYDAY=WE', days: ['2026-09-09'], dueTime: '18:00', requiresApproval: true })],
    },
    {
      id: 'p3', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0653F', memberType: 'kid', isAdmin: false,
      recurringChores: 0,
      chores: [chore({ id: 'l1', title: 'Renew the passport', carriedOver: true })],
    },
  ],
  unassigned: [
    chore({ id: 'c1', title: 'Sweep the porch', emoji: '🧹', cadence: 'weekly', rrule: 'FREQ=WEEKLY;BYDAY=SU', days: [WEEK], rewardAmount: 2, pendingInstanceIds: ['i1', 'i2'] }),
    chore({ id: 'c2', title: 'Fold the towels', emoji: '🧺', rewardAmount: 1 }),
  ],
}

let calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A STATEFUL double: a PATCH really moves the chore, so what the screen shows after a
// hand-out is the re-read rather than component bookkeeping.
function mockApi(opts: { capabilities?: string[]; unassigned?: unknown[] } = {}) {
  calls = []
  const state = JSON.parse(JSON.stringify(BOARD)) as typeof BOARD
  if (opts.unassigned) state.unassigned = opts.unassigned as typeof BOARD.unassigned
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/weekly-planning/tasks')) return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) }
    if (u.includes('/api/household')) {
      return {
        ok: true,
        json: async () => ({
          provisioned: true,
          household: { id: 'h1', name: 'Sites' },
          person: { id: 'p1', name: 'Kevin', capabilities: opts.capabilities ?? ['chore.manage'] },
        }),
      }
    }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: state.people }) }
    if (u.includes('/api/currencies')) {
      return { ok: true, json: async () => ({ currencies: [{ key: 'stars', label: 'Stars', symbol: '⭐', isDefault: true }] }) }
    }
    if (u.endsWith('/api/chores') && method === 'POST') return { ok: true, json: async () => ({ chore: { id: 'new' } }) }
    if (/\/api\/chores\/[^/]+$/.test(u) && method === 'PATCH') {
      const id = u.split('/').pop()!
      const patch = (body ?? {}) as { personId?: string | null; dueOn?: string; title?: string }
      let card: Card | undefined
      const i = state.unassigned.findIndex((c) => c.id === id)
      if (i >= 0) card = state.unassigned[i]
      for (const p of state.people) {
        const j = p.chores.findIndex((c) => c.id === id)
        if (j >= 0) card = p.chores[j]
      }
      if (card && 'personId' in patch) {
        state.unassigned = state.unassigned.filter((c) => c.id !== id)
        for (const p of state.people) p.chores = p.chores.filter((c) => c.id !== id)
        const target = state.people.find((p) => p.id === patch.personId)
        if (target) target.chores.push(card)
        else state.unassigned.push(card)
      }
      if (card && typeof patch.title === 'string') {
        card.title = patch.title
        if ('emoji' in patch) card.emoji = (patch as { emoji: string | null }).emoji
        if (typeof (patch as { rewardAmount?: number }).rewardAmount === 'number') {
          card.rewardAmount = (patch as { rewardAmount: number }).rewardAmount
        }
      }
      if (card && typeof patch.dueOn === 'string') {
        card.dueOn = patch.dueOn
        card.days = patch.dueOn >= WEEK ? [patch.dueOn] : []
        card.carriedOver = false
      }
      return { ok: true, json: async () => ({ chore: { id } }) }
    }
    if (u.includes('/assign')) return { ok: true, json: async () => ({ instance: { id: 'i1', status: 'pending' } }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const props = (over: Partial<StepBodyProps> = {}): StepBodyProps => ({
  step,
  sessionId: 's1',
  weekStart: WEEK,
  setDecisionData: vi.fn(),
  refresh: vi.fn(),
  busy: false,
  ...over,
})

const column = (name: string) => screen.getByTestId(`wpt-col-${name}`)
const strip = () => screen.getByTestId('wpt-strip')
const wrote = (method: string, match: string) => calls.filter((c) => c.method === method && c.url.includes(match))

describe('TasksStep · the verb it lends the parked-note banner', () => {
  // The banner stays in the SHELL. What the step lends it is one VERB, and that verb opens
  // the step's OWN composer: no second way to add a chore.
  const lend = () => {
    let action: HandoffAction | null = null
    const finish = vi.fn()
    render(
      <HandoffCtx.Provider value={{ register: (a) => { action = a }, finish }}>
        <Body {...props()} />
      </HandoffCtx.Provider>
    )
    return { act: () => action as HandoffAction | null, finish }
  }

  it('lends "Make a task", and it opens THIS step’s own chore composer on the note', async () => {
    mockApi()
    const { act } = lend()
    await waitFor(() => expect(act()).toBeTruthy())
    expect(act()!.label).toBe('Make a task')

    act()!.run('book the campsite')

    const title = await screen.findByPlaceholderText('Feed the dog')
    expect((title as HTMLInputElement).value).toBe('book the campsite')
  })

  it('settles the note only when a task was really created', async () => {
    mockApi()
    const { act, finish } = lend()
    await waitFor(() => expect(act()).toBeTruthy())
    act()!.run('book the campsite')
    await screen.findByPlaceholderText('Feed the dog')

    // Ticking the note off here would throw away the only record that it still needs doing.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(finish).toHaveBeenCalledWith(false))
  })
})

describe('TasksStep', () => {
  it('lays the week out by person: what they carry, when it lands, what they already hold', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    for (const name of ['Kevin', 'Wally', 'Lottie']) expect(column(name)).toBeTruthy()

    expect(within(column('Kevin')).getByText('1 this week')).toBeTruthy()
    const wally = column('Wally')
    expect(within(wally).getByText(/Vacuum upstairs/)).toBeTruthy()
    expect(within(wally).getByText('Recurring chore')).toBeTruthy()
    expect(within(wally).getByText('Wed 6pm')).toBeTruthy()
    expect(within(column('Kevin')).getByText('Every day')).toBeTruthy()
    expect(within(column('Lottie')).getByText('Carried over')).toBeTruthy()
    expect(within(column('Lottie')).getByText('Left over from before this week')).toBeTruthy()
    expect(within(strip()).getByText('Sun')).toBeTruthy()
    expect(within(strip()).getByRole('button', { name: 'Set the day for Fold the towels' }).textContent).toBe('Set a day')

    expect(within(column('Kevin')).getByText(/4 recurring chores/)).toBeTruthy()
    expect(within(column('Wally')).getByText(/1 recurring chore\b/)).toBeTruthy()
    expect(within(column('Lottie')).getByText(/No recurring chores/)).toBeTruthy()
  })

  it('tapping a face hands the chore over — and the column shows it because it re-read', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    const reads = wrote('GET', '/api/weekly-planning/tasks').length

    fireEvent.click(screen.getByRole('button', { name: 'Give Sweep the porch to Wally' }))

    await waitFor(() => expect(wrote('PATCH', '/api/chores/c1')).toHaveLength(1))
    expect(wrote('PATCH', '/api/chores/c1')[0].body).toEqual({ personId: 'p2' })
    // EVERY day already sitting unclaimed on a board moves with it, not just the first —
    // otherwise the kiosk Chores screen keeps showing those up for grabs.
    expect(wrote('POST', '/api/chore-instances/i1/assign')[0].body).toEqual({ personId: 'p2' })
    await waitFor(() => expect(wrote('POST', '/api/chore-instances/i2/assign')).toHaveLength(1))
    expect(wrote('POST', '/api/chore-instances/i2/assign')[0].body).toEqual({ personId: 'p2' })

    await waitFor(() => expect(wrote('GET', '/api/weekly-planning/tasks').length).toBeGreaterThan(reads))
    await waitFor(() => expect(within(column('Wally')).getByText(/Sweep the porch/)).toBeTruthy())
    expect(within(strip()).queryByText(/Sweep the porch/)).toBeNull()
    expect(within(column('Wally')).getByText('2 this week')).toBeTruthy()
  })

  it('a chore left alone stays up for grabs — a real answer, not an error', async () => {
    mockApi()
    const setDecisionData = vi.fn()
    render(<Body {...props({ setDecisionData })} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Give Sweep the porch to Lottie' }))
    await waitFor(() => expect(within(column('Lottie')).getByText(/Sweep the porch/)).toBeTruthy())

    expect(wrote('PATCH', '/api/chores/c2')).toHaveLength(0)
    expect(within(strip()).getByText(/Fold the towels/)).toBeTruthy()
    expect(strip().textContent).toMatch(/up for grabs/i)
    // Counts only: the recap reads through to chores, so a copy here could only disagree.
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ assigned: 1, leftUpForGrabs: 1 }))
  })

  it('an empty strip says everything’s handed out, and still offers the tile', async () => {
    mockApi({ unassigned: [] })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Everything’s handed out/)).toBeTruthy())
    expect(within(strip()).getByRole('button', { name: /Add a task/ })).toBeTruthy()
  })

  it('“+ Add for …” opens the app’s existing chore modal with Who prefilled', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(column('Wally')).getByRole('button', { name: /Add for Wally/ }))
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    expect(screen.getByPlaceholderText('Feed the dog')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('p2'))
  })

  it('the strip’s own “Add a task” opens the same modal with nobody prefilled', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(strip()).getByRole('button', { name: /Add a task/ }))
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    // '' is ChoreModal's own "— up for grabs —" option: a task nobody owns yet.
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(''))
  })

  it('without chore.manage there is nothing to tap — assigning is not this viewer’s call', async () => {
    mockApi({ capabilities: [] })
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Give Sweep the porch to Wally' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Put Dishes back up for grabs' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Drag / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set the day for Fold the towels' })).toBeNull()
    expect(within(strip()).getByText('No day set')).toBeTruthy()
  })

  it('takes an assignment back — the chore AND every open day of it', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())

    fireEvent.click(within(column('Kevin')).getByRole('button', { name: 'Put Dishes back up for grabs' }))

    await waitFor(() => expect(wrote('PATCH', '/api/chores/k1')).toHaveLength(1))
    expect(wrote('PATCH', '/api/chores/k1')[0].body).toEqual({ personId: null })
    for (const id of ['i7', 'i8']) {
      await waitFor(() => expect(wrote('POST', `/api/chore-instances/${id}/assign`)).toHaveLength(1))
      expect(wrote('POST', `/api/chore-instances/${id}/assign`)[0].body).toEqual({ personId: null })
    }

    await waitFor(() => expect(within(strip()).getByText(/Dishes/)).toBeTruthy())
    expect(within(column('Kevin')).queryByText(/Dishes/)).toBeNull()
  })

  it('hands one straight on to somebody else, without a trip through the strip', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())

    fireEvent.click(within(column('Kevin')).getByRole('button', { name: 'Give Dishes to Lottie' }))

    await waitFor(() => expect(wrote('PATCH', '/api/chores/k1')[0]?.body).toEqual({ personId: 'p3' }))
    expect(wrote('POST', '/api/chore-instances/i8/assign')[0].body).toEqual({ personId: 'p3' })
    await waitFor(() => expect(within(column('Lottie')).getByText(/Dishes/)).toBeTruthy())
    expect(within(column('Lottie')).queryByRole('button', { name: 'Give Dishes to Lottie' })).toBeNull()
  })

  // Drag must do exactly what tapping a face does — no second write path.
  describe('dragging a card', () => {
    const elementFromPoint = document.elementFromPoint
    afterEach(() => {
      document.elementFromPoint = elementFromPoint
    })
    // jsdom does no layout, so elementFromPoint has to be told what's under the pointer.
    const over = (el: Element) => {
      document.elementFromPoint = (() => el) as typeof document.elementFromPoint
    }
    const dropOn = (grip: HTMLElement, target: Element) => {
      fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
      over(target)
      fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
      fireEvent.pointerUp(window)
    }

    it('drops a chore into a person’s column — the same move as tapping their face', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

      dropOn(within(strip()).getByRole('button', { name: 'Drag Sweep the porch to another column' }), column('Wally'))

      await waitFor(() => expect(wrote('PATCH', '/api/chores/c1')[0]?.body).toEqual({ personId: 'p2' }))
      await waitFor(() => expect(wrote('POST', '/api/chore-instances/i2/assign')[0]?.body).toEqual({ personId: 'p2' }))
      await waitFor(() => expect(within(column('Wally')).getByText(/Sweep the porch/)).toBeTruthy())
    })

    it('drops one back onto the strip — drag undoes what drag did', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())

      dropOn(within(column('Kevin')).getByRole('button', { name: 'Drag Dishes to another column' }), strip())

      await waitFor(() => expect(wrote('PATCH', '/api/chores/k1')[0]?.body).toEqual({ personId: null }))
      await waitFor(() => expect(within(strip()).getByText(/Dishes/)).toBeTruthy())
    })

    it('a drop back where it started writes nothing', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())

      dropOn(within(column('Kevin')).getByRole('button', { name: 'Drag Dishes to another column' }), column('Kevin'))

      await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())
      expect(wrote('PATCH', '/api/chores/k1')).toHaveLength(0)
    })
  })

  // The day chip opens the SAME editor the title opens: two edit surfaces can disagree.
  it('the day chip opens the chore editor, and the day saves from there', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Set the day for Fold the towels' }))
    await waitFor(() => expect(screen.getByText('Edit chore')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('On'), { target: { value: '2026-09-09' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(wrote('PATCH', '/api/chores/c2')).toHaveLength(1))
    expect(wrote('PATCH', '/api/chores/c2')[0].body).toMatchObject({ dueOn: '2026-09-09' })
    await waitFor(() => expect(within(strip()).getByText('Wed')).toBeTruthy())
  })

  // The inline picker is GONE, not hidden: two ways to edit one card is how a title change
  // and a day change end up racing each other on the same chore.
  it('has no inline date picker left on the card', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Set the day for Fold the towels' }))
    await waitFor(() => expect(screen.getByText('Edit chore')).toBeTruthy())
    expect(screen.queryByLabelText('Day for Fold the towels')).toBeNull()
  })

  it('leaves a recurring chore’s days to the chore editor', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    // 'Sweep the porch' repeats weekly, so the chip is a statement, not a picker.
    expect(screen.queryByRole('button', { name: 'Set the day for Sweep the porch' })).toBeNull()
  })

  it('the add-a-task modal starts on “Just once” — planning a week is mostly one-offs', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(strip()).getByRole('button', { name: /Add a task/ }))
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Just once' }).className).toContain('on')
    expect(screen.getByRole('button', { name: 'Every day' }).className).not.toContain('on')
    expect(screen.getByText('On')).toBeTruthy()
  })
  it('a task added here lands in the week being planned, not on today', async () => {
    mockApi()
    render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

    fireEvent.click(within(strip()).getByRole('button', { name: /Add a task/ }))
    await waitFor(() => expect(screen.getByText('New chore')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Book the sitter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))

    await waitFor(() => expect(wrote('POST', '/api/chores')).toHaveLength(1))
    expect(wrote('POST', '/api/chores')[0].body).toMatchObject({ title: 'Book the sitter', rrule: null, dueOn: WEEK })
  })
  describe('editing a task from the board', () => {
    it('opens the app’s chore editor, and a rename shows on the board', async () => {
      mockApi()
      render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

      fireEvent.click(within(strip()).getByRole('button', { name: 'Edit Fold the towels' }))

      await waitFor(() => expect(screen.getByText('Edit chore')).toBeTruthy())
      fireEvent.change(screen.getByDisplayValue('Fold the towels'), { target: { value: 'Fold the tea towels' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(wrote('PATCH', '/api/chores/c2')).toHaveLength(1))
      expect(wrote('PATCH', '/api/chores/c2')[0].body).toMatchObject({ title: 'Fold the tea towels' })
      await waitFor(() => expect(within(strip()).getByText(/Fold the tea towels/)).toBeTruthy())
      expect(screen.queryByText('Edit chore')).toBeNull()
    })

    it('prefills from the card — including the flags the card doesn’t show', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(within(column('Wally')).getByText(/Vacuum upstairs/)).toBeTruthy())

      fireEvent.click(within(column('Wally')).getByRole('button', { name: 'Edit Vacuum upstairs' }))
      await waitFor(() => expect(screen.getByText('Edit chore')).toBeTruthy())

      expect(screen.getByRole('button', { name: 'Certain days' }).className).toContain('on')
      expect(await screen.findByDisplayValue('18:00')).toBeTruthy()
      await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('p2'))
      // …and so does "Needs a parent's OK", which the card never draws. A blank prefill here
      // would quietly switch approval OFF the moment anybody fixed a typo.
      expect(screen.getByText('Needs a parent’s OK').closest('button')!.className).toContain('on')
    })

    it('offers no Delete — a planning session decides who does what, not what exists', async () => {
      mockApi()
      render(<Body {...props()} />)
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

      fireEvent.click(within(strip()).getByRole('button', { name: 'Edit Fold the towels' }))
      await waitFor(() => expect(screen.getByText('Edit chore')).toBeTruthy())
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    })

    it('dragging a card never opens the editor', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())

      const grip = within(strip()).getByRole('button', { name: 'Drag Sweep the porch to another column' })
      const elementFromPoint = document.elementFromPoint
      document.elementFromPoint = (() => column('Wally')) as typeof document.elementFromPoint
      fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
      fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
      fireEvent.pointerUp(window)
      document.elementFromPoint = elementFromPoint

      await waitFor(() => expect(wrote('PATCH', '/api/chores/c1')).toHaveLength(1))
      expect(screen.queryByText('Edit chore')).toBeNull()
    })

    it('is not offered to a viewer who can’t save it', async () => {
      mockApi({ capabilities: [] })
      render(<Body {...props()} />)
      await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
      // PATCH /api/chores/:id needs chore.manage, so a modal here could only 403.
      expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
    })
    // The discriminating drop: the pointer lands on ANOTHER card's title button, an enabled
    // control inside the drop zone. It must still resolve to the zone and leave no editor.
    it('drops onto a card’s own title button and still just moves the chore', async () => {
      mockApi()
      render(<Body {...props()} />)
      await waitFor(() => expect(within(column('Kevin')).getByText(/Dishes/)).toBeTruthy())

      const landing = within(strip()).getByRole('button', { name: 'Edit Fold the towels' })
      expect((landing as HTMLButtonElement).disabled).toBe(false)
      const grip = within(column('Kevin')).getByRole('button', { name: 'Drag Dishes to another column' })
      const elementFromPoint = document.elementFromPoint
      document.elementFromPoint = (() => landing) as typeof document.elementFromPoint
      fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
      fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
      fireEvent.pointerUp(window)
      document.elementFromPoint = elementFromPoint

      await waitFor(() => expect(wrote('PATCH', '/api/chores/k1')[0]?.body).toEqual({ personId: null }))
      expect(screen.queryByText('Edit chore')).toBeNull()
      await waitFor(() => expect(within(strip()).getByText(/Dishes/)).toBeTruthy())
    })
  })
})

// HANDING A CHORE OVER IS TWO WRITES, and the second can fail on its own: `handOut`
// PATCHes the chore DEFINITION and then assigns each pending instance. Once the
// definition PATCH has landed, "nothing moved, so there's nothing to undo" is false —
// the failure path still has to re-read and still has to say something.
describe('tasks · when handing a chore over half-fails', () => {
  it('re-reads the board and says so, rather than claiming nothing moved', async () => {
    mockApi()
    const inner = globalThis.fetch as unknown as typeof fetch
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/assign')) throw new Error('offline')
      return (inner as (u: string, i?: RequestInit) => Promise<unknown>)(url, init)
    }) as unknown as typeof fetch

    render(<Body {...props()} />)
    // Sweep the porch has pending instances, so the second write is the one that fails.
    await waitFor(() => expect(screen.getByText(/Sweep the porch/)).toBeTruthy())
    const before = calls.filter((c) => c.method === 'GET' && c.url.includes('/weekly-planning/tasks')).length

    fireEvent.click(within(strip()).getAllByRole('button', { name: /Give Sweep the porch to/ })[0])

    expect(await screen.findByRole('alert')).toBeTruthy()
    await waitFor(() => expect(
      calls.filter((c) => c.method === 'GET' && c.url.includes('/weekly-planning/tasks')).length
    ).toBeGreaterThan(before))
  })
})
