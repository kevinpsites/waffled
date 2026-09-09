import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import mealsStep from './MealsStep'
import type { StepBodyProps } from '../registry'
import type { PlanningMealsView, PlanningShoppingTrip } from '../../../lib/api'

// Step 7 · Meals — seven columns, the footer fill and its undo. `Body` and `FooterExtra`
// are two React trees over one piece of state, so every test mounts BOTH. Every date comes
// from the `weekStart` prop; the server owns the week.

const WEEK = '2026-09-06' // a Sunday
const day = (i: number) => {
  const d = new Date(`${WEEK}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + i)
  return d.toISOString().slice(0, 10)
}

const dinner = (over: Record<string, unknown> = {}) => ({
  entryId: 'e-1',
  title: 'Pasta bake',
  emoji: '🍝',
  recipeId: 'r-1',
  mealId: null,
  imageUrl: null,
  cookName: null,
  cookAvatar: null,
  cookColor: null,
  minutes: 35,
  ...over,
})

const baseView = (): PlanningMealsView => ({
  weekStart: WEEK,
  nights: [
    { date: day(0), events: [], dinner: dinner({ entryId: 'e-0', title: 'Pasta bake', recipeId: 'r-1', cookName: 'Kevin', cookAvatar: '🐻' }) },
    {
      date: day(1),
      events: [{ id: 'ev-1', title: 'Soccer practice', startsAt: `${day(1)}T22:30:00.000Z`, allDay: false, personName: 'Ada', personColor: '#7c5cff' }],
      dinner: dinner({ entryId: 'e-1', title: 'Fish tacos', emoji: '🌮', recipeId: 'r-2' }),
    },
    { date: day(2), events: [], dinner: dinner({ entryId: 'e-2', title: 'Leftovers', emoji: null, recipeId: null }) },
    { date: day(3), events: [{ id: 'ev-2', title: 'Parent night', startsAt: `${day(3)}T00:00:00.000Z`, allDay: true, personName: null, personColor: null }], dinner: null },
    { date: day(4), events: [], dinner: dinner({ entryId: 'e-4', title: 'Eating out', emoji: null, recipeId: null }) },
    { date: day(5), events: [], dinner: null },
    { date: day(6), events: [], dinner: null },
  ],
  emptyDates: [day(3), day(5), day(6)],
  groceries: { items: 24, checked: 3 },
  choresOn: true,
  shopping: null,
})

const trip = (over: Partial<PlanningShoppingTrip> = {}): PlanningShoppingTrip => ({
  choreId: 'ch-1',
  personId: 'p-kelly',
  personName: 'Kelly',
  personAvatar: '🦊',
  personColor: '#e07a3f',
  dueOn: day(6),
  dueTime: '09:00',
  status: 'pending',
  ...over,
})

const filledView = () => {
  const v = baseView()
  const picks: Record<string, string> = { [day(3)]: 'Chili', [day(5)]: 'Stir fry', [day(6)]: 'Soup' }
  v.nights = v.nights.map((n) =>
    picks[n.date] ? { ...n, dinner: dinner({ entryId: `auto-${n.date}`, title: picks[n.date], emoji: '🥘', recipeId: `rr-${n.date}` }) } : n
  )
  v.emptyDates = []
  v.groceries = { items: 31, checked: 3 }
  return v
}

// The receipt exactly as the server hands it back — it must round-trip untouched, since
// it is the proof the undo checks.
const FILLED = [day(3), day(5), day(6)].map((d) => ({ date: d, entryId: `auto-${d}`, recipeId: `rr-${d}`, mealId: null, title: null }))

const plate = (id: string, name: string) => ({
  id, name, servings: 6, isSaved: true, createdBy: null, createdAt: '2026-07-01T00:00:00.000Z',
  recipeCount: 2, emojis: ['🍗', '🥔'], totalMinutes: 70, onHand: null, toBuy: 0, toBuyNames: [], recipes: [],
})

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = []

// A title-only recipe: the picker's search must still find it — a predicate over one of
// those nulls dropped the row.
const titleOnly = (id: string, title: string) => ({ id, title })

const PICKS: Record<string, string> = { [day(3)]: 'Chili', [day(5)]: 'Stir fry', [day(6)]: 'Soup' }

function mockApi(opts: {
  view?: PlanningMealsView
  recipes?: { id: string; title: string }[] | (() => { id: string; title: string }[])
  meals?: ReturnType<typeof plate>[]
} = {}) {
  calls.length = 0
  let view = opts.view ?? baseView()
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: u, method, body })

    if (u.includes('/api/meals/plan-week')) {
      const dates = (body?.dates as string[]) ?? []
      return {
        ok: true,
        json: async () => ({
          start: WEEK,
          mealType: 'dinner',
          via: 'test',
          suggestions: dates.map((d) => ({
            date: d, mealType: 'dinner', title: PICKS[d] ?? 'Something', recipeId: `rr-${d}`,
            emoji: '🥘', minutes: 30, servings: 4, note: null,
          })),
        }),
      }
    }
    if (u.includes('/api/recipes')) {
      const r = typeof opts.recipes === 'function' ? opts.recipes() : opts.recipes
      return { ok: true, json: async () => ({ recipes: r ?? [titleOnly('r-9', 'Chili')] }) }
    }
    // Its OWN endpoint, not the slot write: this is where copy-on-schedule lives.
    if (/\/api\/meals\/[^/]+\/schedule$/.test(u)) {
      return { ok: true, json: async () => ({ entry: { id: 'e-plate', date: day(5), mealType: 'dinner', mealId: 'm-copy' }, meal: opts.meals?.[0] ?? plate('m-1', 'BBQ Sunday') }) }
    }
    if (/\/api\/meals(\?|$)/.test(u)) {
      return { ok: true, json: async () => ({ meals: opts.meals ?? [plate('m-1', 'BBQ Sunday')] }) }
    }
    if (u.includes('/api/persons')) {
      return { ok: true, json: async () => ({ persons: [{ id: 'p-kelly', name: 'Kelly', avatarEmoji: '🦊' }, { id: 'p-kevin', name: 'Kevin', avatarEmoji: '🐻' }] }) }
    }
    if (u.includes('/api/weekly-planning/meals/shopper')) {
      view = { ...view, shopping: body?.dueOn ? trip({ dueOn: body.dueOn as string, personId: (body.personId as string) ?? null, personName: body.personId ? 'Kelly' : null }) : null }
      return { ok: true, json: async () => ({ weekStart: WEEK, shopping: view.shopping, view }) }
    }
    if (u.includes('/api/weekly-planning/meals/fill')) {
      view = filledView()
      return { ok: true, json: async () => ({ weekStart: WEEK, filled: FILLED, view }) }
    }
    if (u.includes('/api/weekly-planning/meals/undo')) {
      view = baseView()
      return { ok: true, json: async () => ({ weekStart: WEEK, cleared: [day(3), day(5), day(6)], kept: [], view }) }
    }
    if (u.includes('/api/weekly-planning/meals')) return { ok: true, json: async () => view }
    return { ok: true, json: async () => ({ ok: true }) }
  }) as unknown as typeof fetch
}

let seq = 0
const setDecisionData = vi.fn()

function props(over: Partial<StepBodyProps> = {}): StepBodyProps {
  return {
    step: {
      key: 'meals', number: 7, title: 'Meals', ask: 'What’s planned, and what’s still open?',
      primary: 'Done', act: 'Run the household', requiresModule: 'meals',
      available: true, status: 'pending', data: {}, decidedAt: null, parked: [],
    },
    // A fresh session per test: the step's state is keyed by session+week.
    sessionId: `s-${++seq}`,
    weekStart: WEEK,
    setDecisionData,
    refresh: vi.fn(),
    busy: false,
    ...over,
  }
}

function draw(p: StepBodyProps = props()) {
  const { Body, FooterExtra } = mealsStep
  return render(
    <div>
      <div data-testid="body"><Body {...p} /></div>
      <div data-testid="foot">{FooterExtra ? <FooterExtra {...p} /> : null}</div>
    </div>
  )
}

const sent = (m: string, frag: string) => calls.filter((c) => c.method === m && c.url.includes(frag))
const nights = () => Array.from(document.querySelectorAll('.wpm-night'))

// The fill opens the SHARED week planner (kiosk/components/PlanWeek.tsx): draft, approve.
const openPlanner = async () => {
  fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))
  return (await screen.findByRole('dialog', { name: /plan the rest of the week/i })) as HTMLElement
}
async function planAndApply() {
  const planner = await openPlanner()
  fireEvent.click(within(planner).getByRole('button', { name: /^plan my week$/i }))
  const apply = await within(planner).findByRole('button', { name: /add week & build list/i })
  fireEvent.click(apply)
}

beforeEach(() => setDecisionData.mockClear())

describe('meals step · the week as it stands', () => {
  it('shows the same seven columns as the calendar, in order', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(nights()).toHaveLength(7)
    expect(sent('GET', '/api/weekly-planning/meals')[0].url).toContain(`weekStart=${WEEK}`)
  })

  it("puts the night's events above its dish", async () => {
    mockApi()
    draw()
    await screen.findByText('Fish tacos')
    const monday = nights()[1]
    const evs = monday.querySelector('.wpm-events')!
    const dish = monday.querySelector('.wpm-dish')!
    expect(within(monday as HTMLElement).getByText('Soccer practice')).toBeTruthy()
    expect(evs.compareDocumentPosition(dish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the plan as-is — four nights set, three empty', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(document.querySelectorAll('.wpm-dish.empty')).toHaveLength(3)
    expect(screen.getByText('Leftovers')).toBeTruthy()
    expect(screen.getByText('Eating out')).toBeTruthy()
  })

  it('keeps groceries to one bar — where it came from, and what is on it', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    const line = document.querySelectorAll('.wpm-gro')
    expect(line).toHaveLength(1)
    expect(line[0].querySelector('.wpm-gro-s')!.textContent).toMatch(/planned so far.*staples skipped/)
    expect(line[0].querySelector('.wpm-gro-pill')!.textContent).toContain('24 items')
    expect(line[0].querySelector('.wpm-gro-pill')!.textContent).toContain('aisle order')
  })

  it('names who is cooking when the plan knows', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(nights()[0].querySelector('.wpm-dish-c')!.textContent).toMatch(/🐻\s*Kevin/)
    expect(nights()[1].querySelector('.wpm-dish-c')!.textContent).toContain('35 min')
  })

  it('gives the dish tile a distinct state for planned, empty and eating out', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(nights()[0].querySelector('.wpm-dish')!.className).toBe('wpm-dish')
    expect(nights()[2].querySelector('.wpm-dish')!.className).toBe('wpm-dish')
    expect(nights()[3].querySelector('.wpm-dish.empty')).toBeTruthy()
    expect(nights()[3].querySelector('.wpm-dish-plus')).toBeTruthy()
    // Classified by the SAME helper the Meals screen uses, so no night reads two ways.
    expect(nights()[4].querySelector('.wpm-dish.out')).toBeTruthy()
  })

  it('renders "nothing on" so the seven dish tiles line up', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    expect(document.querySelectorAll('.wpm-ev-none')).toHaveLength(5)
    expect(document.querySelectorAll('.wpm-night > .wpm-events')).toHaveLength(7)
  })
})

// A plate night is `recipe_id NULL` carrying a meal_id — the shape MealsColumn keys on;
// read any other way a plate looks like a bare title.
describe('meals step · a night that is a plate', () => {
  const plateNight = (title: string) => {
    const v = baseView()
    v.nights = v.nights.map((n) =>
      n.date === day(5)
        ? { ...n, dinner: { ...dinner(), entryId: 'e-plate', title, emoji: null, recipeId: null, mealId: 'm-copy', minutes: null } }
        : n
    )
    v.emptyDates = [day(3), day(6)]
    return v
  }

  it('renders the plate by name, and calls it what it is', async () => {
    mockApi({ view: plateNight('BBQ Sunday') })
    draw()
    await screen.findByText('BBQ Sunday')
    const tile = nights()[5].querySelector('.wpm-dish')!
    expect(tile.querySelector('.wpm-dish-c')!.textContent).toMatch(/a whole plate/i)
  })

  it('never reads a plate as takeout, however it is named', async () => {
    // `isEatingOut` matches a recipe-LESS row's title and a plate is recipe-less, so without
    // the meal_id check a plate would wear the takeout tile.
    mockApi({ view: plateNight('Takeout Tuesday') })
    draw()
    await screen.findByText('Takeout Tuesday')
    const tile = nights()[5].querySelector('.wpm-dish')!
    expect(tile.className).toBe('wpm-dish')
    expect(tile.querySelector('.wpm-dish-c')!.textContent).not.toMatch(/no cooking/i)
    expect(tile.querySelector('.wpm-dish-c')!.textContent).toMatch(/a whole plate/i)
  })
})

describe('meals step · who is shopping', () => {
  it('offers the trip as a control, and names the person once it is assigned', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    const pill = within(screen.getByTestId('body')).getByRole('button', { name: /who's shopping/i })
    expect(pill.className).toContain('wpm-shop')
    fireEvent.click(pill)

    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /kelly/i }))
    fireEvent.click(within(card).getByRole('button', { name: /sat/i }))
    fireEvent.click(within(card).getByRole('button', { name: /add it to tasks/i }))

    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ weekStart: WEEK, personId: 'p-kelly', dueOn: day(6), choreId: null })
    expect(await screen.findByRole('button', { name: /Kelly shops/ })).toBeTruthy()
  })

  it('says so when the trip is planned but up for grabs', async () => {
    mockApi({ view: { ...baseView(), shopping: trip({ personId: null, personName: null, personAvatar: null }) } })
    draw()
    await screen.findByText('Pasta bake')
    expect(screen.getByRole('button', { name: /up for grabs/i })).toBeTruthy()
  })

  it('passes the chore id back so a renamed chore is not duplicated', async () => {
    mockApi({ view: { ...baseView(), shopping: trip() } })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(screen.getByRole('button', { name: /Kelly shops/ }))
    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /update the trip/i }))
    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ choreId: 'ch-1' })
  })

  it('clears the trip rather than leaving an orphan chore', async () => {
    mockApi({ view: { ...baseView(), shopping: trip() } })
    draw()
    await screen.findByText('Pasta bake')
    fireEvent.click(screen.getByRole('button', { name: /Kelly shops/ }))
    const card = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(await within(card).findByRole('button', { name: /no trip this week/i }))
    await waitFor(() => expect(sent('PUT', '/meals/shopper')).toHaveLength(1))
    expect(sent('PUT', '/meals/shopper')[0].body).toMatchObject({ dueOn: null, personId: null })
    await waitFor(() => expect(screen.getByRole('button', { name: /who's shopping/i })).toBeTruthy())
  })

  it('drops the control entirely when the chores module is off', async () => {
    mockApi({ view: { ...baseView(), choresOn: false } })
    draw()
    await screen.findByText('Pasta bake')
    expect(document.querySelector('.wpm-shop')).toBeNull()
    expect(document.querySelector('.wpm-gro-pill')!.textContent).toContain('24 items')
  })
})

describe('meals step · plan the rest for me', () => {
  it('reuses the shared week planner rather than drafting behind a bare button', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    const foot = screen.getByTestId('foot')
    const fill = within(foot).getByRole('button', { name: /plan the rest for me/i })
    expect(fill.className).toContain('btn-ai')
    fireEvent.click(fill)

    const planner = await screen.findByRole('dialog', { name: /plan the rest of the week/i })
    expect(within(planner).getByText(/keep in mind/i)).toBeTruthy()
    expect(within(planner).getByPlaceholderText(/lottie skips spicy/i)).toBeTruthy()
    expect(within(planner).getByRole('switch', { name: /try something new/i })).toBeTruthy()
    expect(sent('POST', '/meals/fill')).toHaveLength(0)
  })

  it('offers the planner ONLY the empty nights, and asks the model for just those', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    const planner = await openPlanner()

    // A chip for a night somebody already decided would draft a dish the fill then refuses.
    expect(planner.querySelectorAll('.plan-day-chip')).toHaveLength(3)
    expect(within(planner).getByText(/three empty nights/i)).toBeTruthy()
    expect(planner.querySelector('.seg-plantype')).toBeNull()

    fireEvent.click(within(planner).getByRole('button', { name: /^plan my week$/i }))
    await waitFor(() => expect(sent('POST', '/api/meals/plan-week')).toHaveLength(1))
    expect(sent('POST', '/api/meals/plan-week')[0].body).toMatchObject({
      start: WEEK, mealType: 'dinner', dates: [day(3), day(5), day(6)],
    })
  })

  it("applies the approved week through the step's own fill, and marks what it filled", async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    // NOT through POST /api/meals/plan: only the step's fill refuses a decided night AND
    // hands back the receipt the undo checks.
    await waitFor(() => expect(sent('POST', '/meals/fill')).toHaveLength(1))
    expect(calls.filter((c) => c.method === 'POST' && /\/api\/meals\/plan$/.test(c.url))).toHaveLength(0)
    const body = sent('POST', '/meals/fill')[0].body!
    expect(body.weekStart).toBe(WEEK)
    expect((body.cards as { date: string }[]).map((c) => c.date)).toEqual([day(3), day(5), day(6)])

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /plan the rest of the week/i })).toBeNull())
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)
    expect(screen.getByText('Pasta bake')).toBeTruthy()
    expect(screen.getByText('Leftovers')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.wpm-gro-s')!.textContent).toContain('7 items added'))
    expect(document.querySelector('.wpm-gro-pill')!.textContent).toContain('31 items')
  })

  it('turns the same footer slot into "Undo the three"', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    const undo = await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the three/i })
    expect(within(screen.getByTestId('foot')).queryByRole('button', { name: /plan the rest for me/i })).toBeNull()

    fireEvent.click(undo)
    await waitFor(() => expect(sent('POST', '/meals/undo')).toHaveLength(1))
    expect(sent('POST', '/meals/undo')[0].body).toEqual({ weekStart: WEEK, filled: FILLED })

    await waitFor(() => expect(document.querySelectorAll('.wpm-dish.empty')).toHaveLength(3))
    expect(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i })).toBeTruthy()
  })

  it('records the crumb the session should keep — the dates, never the meals', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()

    await waitFor(() => expect(setDecisionData).toHaveBeenCalledWith({ autoFilled: [day(3), day(5), day(6)] }))
    fireEvent.click(await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the three/i }))
    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith(null))
  })

  it('has nothing to offer once every night is planned', async () => {
    mockApi({ view: filledView() })
    draw()
    await screen.findByText('Chili')
    const fill = within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i })
    expect((fill as HTMLButtonElement).disabled).toBe(true)
  })

  it('restores the MARKS from the session crumb on a revisit — but not the undo', async () => {
    mockApi({ view: filledView() })
    draw(props({ step: { ...props().step, status: 'done', data: { autoFilled: [day(3), day(5), day(6)] } } }))
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)

    // The crumb is DATES, so it cannot prove what the fill wrote: no batch undo on a revisit.
    const foot = within(screen.getByTestId('foot'))
    expect(foot.queryByRole('button', { name: /undo the/i })).toBeNull()
    expect((foot.getByRole('button', { name: /plan the rest for me/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

// Tapping a night opens the app's OWN `RecipeBrowser` — the same one behind the Meals screen
// — and every way out of it writes through the same meal-plan endpoint.
describe('meals step · picking a dish for one night', () => {
  const library = () => [titleOnly('r-9', 'Chili'), titleOnly('r-8', 'Fish tacos'), titleOnly('r-7', 'Soup')]

  const openNight = (i: number): HTMLElement => {
    fireEvent.click(nights()[i].querySelector('.wpm-dish')!)
    return document.querySelector('.wpm-picker') as HTMLElement
  }
  const cards = (picker: HTMLElement) => Array.from(picker.querySelectorAll('.mp-card')) as HTMLElement[]
  const titles = (picker: HTMLElement) => cards(picker).map((c) => c.querySelector('.rc-t')?.textContent ?? '')
  const cardNamed = (picker: HTMLElement, title: string): HTMLElement => {
    const found = cards(picker).find((c) => (c.querySelector('.rc-t')?.textContent ?? '').includes(title))
    if (!found) throw new Error(`no card titled ${title} — saw ${JSON.stringify(titles(picker))}`)
    return found
  }
  const selectCard = (picker: HTMLElement, title: string) =>
    fireEvent.click(cardNamed(picker, title).querySelector('.mp-select')!)
  const search = (picker: HTMLElement) => picker.querySelector('.picker-search input') as HTMLInputElement
  const planned = () => sent('POST', '/api/meals/plan').filter((c) => !c.url.includes('plan-week'))

  it("opens the app's recipe browser, not a list of chips", async () => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)

    expect(picker.querySelector('.meals-picker')).toBeTruthy()
    expect(search(picker).placeholder).toMatch(/search recipes by name/i)
    expect(picker.querySelectorAll('.picker-filters .mp-filter').length).toBeGreaterThan(1)
    await waitFor(() => expect(cardNamed(picker, 'Chili')).toBeTruthy())
    expect(document.querySelectorAll('.wpm-recipe')).toHaveLength(0)
    expect(within(picker).getByText(/fri dinner/i)).toBeTruthy()
  })

  it('filters the grid as you type', async () => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)
    await waitFor(() => expect(titles(picker)).toEqual(expect.arrayContaining(['Chili', 'Fish tacos', 'Soup'])))

    fireEvent.change(search(picker), { target: { value: 'chi' } })
    const shown = titles(picker)
    expect(shown).toContain('Chili')
    expect(shown).not.toContain('Soup')
    expect(shown).not.toContain('Fish tacos')
  })

  it('plans the night from the recipe card', async () => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)
    await waitFor(() => expect(cardNamed(picker, 'Chili')).toBeTruthy())

    selectCard(picker, 'Chili')

    await waitFor(() => expect(planned()).toHaveLength(1))
    expect(planned()[0].body).toMatchObject({ date: day(5), mealType: 'dinner', recipeId: 'r-9' })
    expect(planned()[0].body!.title).toBeNull()
    await waitFor(() => expect(document.querySelector('.wpm-picker')).toBeNull())
  })

  // The placeholder cards write the exact recipe-less rows `isEatingOut` / `isLeftovers` /
  // `isTryNew` classify; free text approximating them makes two screens disagree.
  it.each([
    ['Eating out', 'Eating out'],
    ['Leftovers', 'Leftovers'],
    ['Try something new', 'Try something new'],
  ])('plans %s as the same recipe-less row the Meals screen writes', async (card, title) => {
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)

    selectCard(picker, card)
    await waitFor(() => expect(planned()).toHaveLength(1))
    expect(planned()[0].body).toMatchObject({ date: day(5), mealType: 'dinner', title, recipeId: null })
  })

  it('still plans a one-off dish that is in neither the library nor the cards', async () => {
    // The browser's own search box doubles as the way to say a dish nobody saved.
    mockApi({ recipes: library() })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)
    await waitFor(() => expect(cardNamed(picker, 'Chili')).toBeTruthy())

    expect(picker.querySelector('.picker-grid')!.textContent).not.toMatch(/plan it as typed/i)
    fireEvent.change(search(picker), { target: { value: "Grandma's lasagne" } })
    expect(within(picker).getByText(/plan it as typed/i)).toBeTruthy()

    selectCard(picker, "Grandma's lasagne")
    await waitFor(() => expect(planned()).toHaveLength(1))
    expect(planned()[0].body).toMatchObject({ date: day(5), title: "Grandma's lasagne", recipeId: null })
  })

  it('picks up a recipe added since the step was first opened', async () => {
    // An EMPTY library is a truthy `[]`, so caching the list behind `if (recipes) return`
    // told a household with no recipes "no recipes yet" for good. `useRecipes` stays the source.
    let lib: { id: string; title: string }[] = []
    mockApi({ recipes: () => lib })
    draw()
    await screen.findByText('Pasta bake')

    let picker = openNight(5)
    await waitFor(() => expect(picker.querySelector('.picker-empty')).toBeTruthy())
    fireEvent.click(within(picker).getByRole('button', { name: /back to the week/i }))

    lib = [titleOnly('r-1', 'Dummy recipe')]
    picker = openNight(6)
    await waitFor(() => expect(cardNamed(picker, 'Dummy recipe')).toBeTruthy())
  })

  // PLATE PARITY: the browser lists plates only for a caller that can say WHERE one goes,
  // since the date lives in the caller's closure. `onPickMeal` is all of it.
  it('offers the household\'s saved plates beside its recipes', async () => {
    mockApi({ recipes: library(), meals: [plate('m-1', 'BBQ Sunday')] })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)

    await waitFor(() => expect(cardNamed(picker, 'BBQ Sunday')).toBeTruthy())
    expect(within(cardNamed(picker, 'BBQ Sunday')).getByText(/meal · 2/i)).toBeTruthy()
    expect(cardNamed(picker, 'Chili')).toBeTruthy()
  })

  it('plans a night as a plate through the schedule endpoint, not a slot write', async () => {
    mockApi({ recipes: library(), meals: [plate('m-1', 'BBQ Sunday')] })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)
    await waitFor(() => expect(cardNamed(picker, 'BBQ Sunday')).toBeTruthy())

    selectCard(picker, 'BBQ Sunday')
    // Its OWN endpoint: copy-on-schedule lives there, so editing the library plate later
    // can't rewrite a night that already happened.
    await waitFor(() => expect(sent('POST', '/api/meals/m-1/schedule')).toHaveLength(1))
    expect(sent('POST', '/api/meals/m-1/schedule')[0].body).toMatchObject({ date: day(5), mealType: 'dinner' })
    expect(planned()).toHaveLength(0)
    await waitFor(() => expect(document.querySelector('.wpm-picker')).toBeNull())
  })

  it('says so plainly when there is nothing in the library yet', async () => {
    mockApi({ recipes: [] })
    draw()
    await screen.findByText('Pasta bake')
    const picker = openNight(5)

    await waitFor(() => expect(picker.querySelector('.picker-empty')!.textContent).toMatch(/no dinner recipes yet/i))
    expect(cardNamed(picker, 'Eating out')).toBeTruthy()
    expect(within(picker).getByRole('button', { name: /new recipe/i })).toBeTruthy()
  })
})

describe('meals step · overwriting a set night', () => {
  const openNight = (i: number): HTMLElement => {
    fireEvent.click(nights()[i].querySelector('.wpm-dish')!)
    return document.querySelector('.wpm-picker') as HTMLElement
  }
  const planned = () => sent('POST', '/api/meals/plan').filter((c) => !c.url.includes('plan-week'))
  const selectCard = (picker: HTMLElement, title: string) => {
    const found = (Array.from(picker.querySelectorAll('.mp-card')) as HTMLElement[])
      .find((c) => (c.querySelector('.rc-t')?.textContent ?? '').includes(title))!
    fireEvent.click(found.querySelector('.mp-select')!)
  }

  it('is a tap on that night, and writes through the existing meal-plan endpoint', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    const picker = openNight(5)
    expect(picker).toBeTruthy()
    await waitFor(() => expect(picker.textContent).toContain('Chili'))
    selectCard(picker, 'Chili')
    await waitFor(() => expect(planned()).toHaveLength(1))
    expect(planned()[0].body).toMatchObject({ date: day(5), mealType: 'dinner', recipeId: 'r-9' })
  })

  it('clears a night through the existing endpoint too', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')

    const picker = openNight(0)
    expect(within(picker).getByText(/currently pasta bake/i)).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: /clear this night/i }))
    await waitFor(() => expect(sent('DELETE', '/api/meals/plan')).toHaveLength(1))
    expect(sent('DELETE', '/api/meals/plan')[0].url).toContain(`date=${day(0)}`)
  })

  it('stops calling a hand-decided night auto-filled', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    await planAndApply()
    await screen.findByText('Chili')
    expect(document.querySelectorAll('.wpm-dish.auto')).toHaveLength(3)

    // Overwrite one of the three by hand — this proves the auto-fill mark is dropped too.
    const picker = openNight(5)
    await waitFor(() => expect(picker.textContent).toContain('Chili'))
    selectCard(picker, 'Chili')

    await waitFor(() => expect(setDecisionData).toHaveBeenLastCalledWith({ autoFilled: [day(3), day(6)] }))
    expect(await within(screen.getByTestId('foot')).findByRole('button', { name: /undo the two/i })).toBeTruthy()
  })

  it('opening the week planner wins over an open night picker', async () => {
    mockApi()
    draw()
    await screen.findByText('Pasta bake')
    openNight(5)
    expect(document.querySelector('.wpm-picker')).toBeTruthy()

    // jsdom has no layout and the two flags live in different places (one in Body, one in
    // the store), so the guard in Body is what makes "only one" structural.
    fireEvent.click(within(screen.getByTestId('foot')).getByRole('button', { name: /plan the rest for me/i }))
    await screen.findByRole('dialog', { name: /plan the rest of the week/i })
    expect(document.querySelector('.wpm-picker')).toBeNull()
  })
})
