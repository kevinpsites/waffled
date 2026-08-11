import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider, useTopbarSlots } from '../topbar-slot'

function TopbarProbe() {
  return <>{useTopbarSlots().full}</>
}

const kelly = { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' }

// A manual item a kid hand-added, and an auto item built from the meal plan.
const manualItem = {
  id: 'm1',
  name: 'Cookies',
  quantity: null,
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 0,
  assignee: null,
  aisle: '',
  source: 'manual',
  sourceRecipeIds: [],
  addedBy: kelly,
}
const autoItem = {
  id: 'a1',
  name: 'Tomatoes',
  quantity: '2',
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 1,
  assignee: null,
  aisle: '',
  source: 'auto',
  sourceRecipeIds: ['r1'],
  addedBy: null,
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

function mockBoard() {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/lists/grocery/board')) {
      return ok({
        list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 2 },
        weekStart: '2026-06-07',
        // a planned dinner so the auto item gets a meal dot color
        meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', title: 'Pasta', emoji: '🍝', color: '#1f5fd0' }],
        items: [manualItem, autoItem],
        staples: [],
      })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderBoard() {
  return render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <TopbarProbe />
        <GroceryBoard onBack={() => {}} />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('GroceryBoard item attribution', () => {
  it('does not present actions that have no implementation', async () => {
    mockBoard()
    renderBoard()

    await screen.findByText('Cookies')
    expect(screen.queryByRole('button', { name: /Send to phone/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Order online/i })).not.toBeInTheDocument()
  })

  it('shows "added by {name}" for a manual item but not for an auto item', async () => {
    mockBoard()
    renderBoard()

    // manual item is attributed to the person who added it
    expect(await screen.findByText('Cookies')).toBeInTheDocument()
    const cookies = screen.getByText('Cookies').closest('.gitem') as HTMLElement
    expect(cookies.textContent).toContain('added by Kelly')

    // an auto item reads as auto-generated from the meal plan, never "added by"
    const tomatoes = screen.getByText('Tomatoes').closest('.gitem') as HTMLElement
    expect(tomatoes.textContent).toContain('from meal plan')
    expect(tomatoes.textContent).not.toContain('added by')
  })

  it('shows the meal-plan indicator only on the auto item', async () => {
    mockBoard()
    renderBoard()

    await screen.findByText('Cookies')
    const cookies = screen.getByText('Cookies').closest('.gitem') as HTMLElement
    expect(cookies.textContent).not.toContain('from meal plan')
  })
})

// An item added straight from a recipe page (recipe not planned this week) —
// the board's `unscheduled` array gives it its own by-meal section.
const offPlanItem = {
  id: 'u1',
  name: 'Avocados',
  quantity: '3',
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 2,
  assignee: null,
  aisle: '',
  source: 'auto',
  sourceRecipeIds: ['r2'],
  addedBy: null,
}

function mockBoardWithUnscheduled(extra: { items?: unknown[]; unscheduled?: unknown[] } = {}) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/lists/grocery/board')) {
      return ok({
        list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 3 },
        weekStart: '2026-06-07',
        meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', title: 'Pasta', emoji: '🍝', color: '#1f5fd0' }],
        unscheduled: extra.unscheduled ?? [{ recipeId: 'r2', title: 'Guacamole', emoji: '🥑', color: '#8B5CF6' }],
        items: extra.items ?? [manualItem, autoItem, offPlanItem],
        staples: [],
      })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('GroceryBoard unscheduled recipes (By meal view)', () => {
  it('groups off-plan recipe items under their own "unscheduled" section, not "Other items"', async () => {
    mockBoardWithUnscheduled()
    renderBoard()
    await screen.findByText('Avocados')
    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    // the rail legend lists it under the week's meals, below the divider
    const rail = document.querySelector('.grocery-railcard') as HTMLElement
    expect(rail.textContent).toContain('Guacamole')

    // the off-plan recipe gets its own section, tagged as unscheduled
    const header = screen.getAllByText('Guacamole').map((el) => el.closest('.grocery-section-h')).find(Boolean) as HTMLElement
    expect(header).toBeInTheDocument()
    expect(header.textContent).toMatch(/unscheduled/i)
    const section = header.closest('.grocery-section') as HTMLElement
    expect(section.textContent).toContain('Avocados')

    // hand-added leftovers still land in "Other items"; the recipe item doesn't
    const other = screen.getByText('Other items').closest('.grocery-section') as HTMLElement
    expect(other.textContent).toContain('Cookies')
    expect(other.textContent).not.toContain('Avocados')
  })

  it('renders an item shared by a planned and an unscheduled recipe only once, under the planned meal', async () => {
    // limes feed planned Pasta (r1) AND off-plan Guacamole (r2) — one row, claimed
    // by the planned meal first (mirrors iOS's MealGrouping)
    const shared = { ...offPlanItem, id: 's1', name: 'Limes', sourceRecipeIds: ['r1', 'r2'] }
    mockBoardWithUnscheduled({ items: [autoItem, shared, offPlanItem] })
    renderBoard()
    await screen.findByText('Limes')
    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    expect(screen.getAllByText('Limes')).toHaveLength(1)
    // 'Pasta' also appears in the week rail — take its *section* occurrence
    const pasta = screen.getAllByText('Pasta').map((el) => el.closest('.grocery-section')).find(Boolean) as HTMLElement
    expect(pasta.textContent).toContain('Limes')
    const guac = screen.getAllByText('Guacamole').map((el) => el.closest('.grocery-section')).find(Boolean) as HTMLElement
    expect(guac.textContent).not.toContain('Limes')
    expect(guac.textContent).toContain('Avocados')
  })

  it('removes an off-plan recipe from the list via the section Remove button', async () => {
    const sent: { method: string; url: string }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url)
      sent.push({ method: init?.method ?? 'GET', url: u })
      if (u.includes('/api/lists/grocery/board')) {
        return ok({
          list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 1 },
          weekStart: '2026-06-07',
          meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', title: 'Pasta', emoji: '🍝', color: '#1f5fd0' }],
          unscheduled: [{ recipeId: 'r2', title: 'Guacamole', emoji: '🥑', color: '#8B5CF6' }],
          items: [offPlanItem],
          staples: [],
        })
      }
      return ok({})
    }) as unknown as typeof fetch

    renderBoard()
    await screen.findByText('Avocados')
    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    const header = screen.getAllByText('Guacamole').map((el) => el.closest('.grocery-section-h')).find(Boolean) as HTMLElement
    fireEvent.click(within(header).getByRole('button', { name: /Remove/i }))

    await waitFor(() =>
      expect(sent.some((s) => s.method === 'DELETE' && /\/api\/lists\/grocery\/from-recipe\/r2\?weekStart=2026-06-07$/.test(s.url))).toBe(true)
    )
  })
})

// Rail rows drill into the recipe, matching iOS.
describe('GroceryBoard rail navigation', () => {
  function renderWithRecipeRoute() {
    return render(
      <MemoryRouter>
        <TopbarSlotProvider>
          <Routes>
            <Route path="/" element={<GroceryBoard onBack={() => {}} />} />
            <Route path="/meals/recipe/:id" element={<div>recipe-page</div>} />
          </Routes>
        </TopbarSlotProvider>
      </MemoryRouter>
    )
  }

  it('opens the recipe when a planned rail meal is clicked', async () => {
    mockBoardWithUnscheduled()
    renderWithRecipeRoute()
    await screen.findByText('Avocados')
    const rail = document.querySelector('.grocery-railcard') as HTMLElement
    fireEvent.click(within(rail).getByText('Pasta'))
    expect(await screen.findByText('recipe-page')).toBeInTheDocument()
  })

  it('opens the recipe when an unscheduled rail row is clicked', async () => {
    mockBoardWithUnscheduled()
    renderWithRecipeRoute()
    await screen.findByText('Avocados')
    const rail = document.querySelector('.grocery-railcard') as HTMLElement
    fireEvent.click(within(rail).getByText('Guacamole'))
    expect(await screen.findByText('recipe-page')).toBeInTheDocument()
  })

  it('removes an off-plan recipe from the rail\'s Unscheduled row without navigating', async () => {
    const sent: { method: string; url: string }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url)
      sent.push({ method: init?.method ?? 'GET', url: u })
      if (u.includes('/api/lists/grocery/board')) {
        return ok({
          list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 1 },
          weekStart: '2026-06-07',
          meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', title: 'Pasta', emoji: '🍝', color: '#1f5fd0' }],
          unscheduled: [{ recipeId: 'r2', title: 'Guacamole', emoji: '🥑', color: '#8B5CF6' }],
          items: [offPlanItem],
          staples: [],
        })
      }
      return ok({})
    }) as unknown as typeof fetch

    renderWithRecipeRoute()
    await screen.findByText('Avocados')
    const rail = document.querySelector('.grocery-railcard') as HTMLElement
    fireEvent.click(within(rail).getByRole('button', { name: /Remove Guacamole/i }))

    // fires the delete for that recipe
    await waitFor(() =>
      expect(sent.some((s) => s.method === 'DELETE' && /\/api\/lists\/grocery\/from-recipe\/r2\?weekStart=2026-06-07$/.test(s.url))).toBe(true)
    )
    // and does NOT drill into the recipe (stopPropagation on the × button)
    expect(screen.queryByText('recipe-page')).not.toBeInTheDocument()
  })
})

// ---- Meal Builder plates in the week rail ----------------------------------
// A plate (a named, multi-recipe meal) renders as ONE parent row that expands to
// its dishes. A plain single-recipe slot must keep rendering exactly as before.

const plateDishes = [
  { recipeId: 'd1', title: 'BBQ Chicken', emoji: '🍗', role: 'main' },
  { recipeId: 'd2', title: 'Potato Salad', emoji: '🥔', role: 'side' },
  { recipeId: 'd3', title: 'Coleslaw', emoji: '🥗', role: 'side' },
]
// The plate's shopping: one row credited to TWO of its dishes (a shared
// ingredient) — it must still get exactly one dot, in the plate's colour.
const plateItem = {
  id: 'pi1',
  name: 'BBQ sauce',
  quantity: '1 bottle',
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 3,
  assignee: null,
  aisle: '',
  source: 'auto',
  sourceRecipeIds: ['d1', 'd2'],
  sourceMealIds: [],
  addedBy: null,
}
const tacoNight = {
  mealId: 'M2',
  name: 'Taco Night',
  color: '#8B5CF6',
  recipes: [{ recipeId: 'd4', title: 'Carnitas', emoji: '🌮', role: 'main' }],
}

function mockBoardWithPlate(extra: { items?: unknown[]; unscheduled?: unknown[]; unscheduledMeals?: unknown[] } = {}) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/lists/grocery/board')) {
      return ok({
        list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 2 },
        weekStart: '2026-06-07',
        meals: [
          // a plain single-recipe slot — mealId null, no dishes
          { date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', mealId: null, title: 'Pasta', emoji: '🍝', color: '#1f5fd0', recipes: [] },
          // …and a plate in Sunday's dinner slot
          { date: '2026-06-09', mealType: 'dinner', recipeId: null, mealId: 'M1', title: 'BBQ Sunday', emoji: null, color: '#E8A33D', recipes: plateDishes },
        ],
        unscheduled: extra.unscheduled ?? [],
        unscheduledMeals: extra.unscheduledMeals ?? [],
        items: extra.items ?? [autoItem, plateItem],
        staples: [],
      })
    }
    return ok({})
  }) as unknown as typeof fetch
}

const railCard = () => document.querySelector('.grocery-railcard') as HTMLElement

describe('GroceryBoard meal plates (week rail)', () => {
  it('renders a plate as one collapsed parent row with a count pill and a dish emoji strip', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')

    const rail = railCard()
    const parent = within(rail).getByText('BBQ Sunday').closest('.gdinner') as HTMLElement
    expect(parent).toHaveClass('gdinner-plate')
    expect(parent.textContent).toContain('Meal · 3')
    // an expand affordance, not the plain drill-in caret
    expect(parent.querySelector('.cal-chev')).toBeTruthy()
    // the dishes stay tucked away until it's expanded…
    expect(within(rail).queryByText('Potato Salad')).not.toBeInTheDocument()
    expect(rail.querySelectorAll('.gdish')).toHaveLength(0)
    // …but the parent previews them as emoji
    expect(parent.querySelector('.gplate-strip')?.textContent).toContain('🍗')
  })

  it('expands a plate into one child row per dish, and collapses again', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')

    const rail = railCard()
    const parent = within(rail).getByText('BBQ Sunday').closest('.gdinner') as HTMLElement
    fireEvent.click(parent)

    expect(rail.querySelectorAll('.gdish')).toHaveLength(3)
    expect(within(rail).getByText('BBQ Chicken')).toBeInTheDocument()
    expect(within(rail).getByText('Potato Salad')).toBeInTheDocument()
    expect(within(rail).getByText('Coleslaw')).toBeInTheDocument()

    fireEvent.click(parent)
    expect(rail.querySelectorAll('.gdish')).toHaveLength(0)
  })

  it('opens the recipe when a plate’s dish row is clicked', async () => {
    mockBoardWithPlate()
    render(
      <MemoryRouter>
        <TopbarSlotProvider>
          <Routes>
            <Route path="/" element={<GroceryBoard onBack={() => {}} />} />
            <Route path="/meals/recipe/:id" element={<div>recipe-page</div>} />
          </Routes>
        </TopbarSlotProvider>
      </MemoryRouter>
    )
    await screen.findByText('BBQ sauce')
    const rail = railCard()
    fireEvent.click(within(rail).getByText('BBQ Sunday'))
    fireEvent.click(within(rail).getByText('Potato Salad'))
    expect(await screen.findByText('recipe-page')).toBeInTheDocument()
  })

  // Regression guard: a single-recipe slot keeps its drill-in caret and gains no
  // expand affordance.
  it('leaves a plain single-recipe slot un-expandable', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')

    const rail = railCard()
    const pasta = within(rail).getByText('Pasta').closest('.gdinner') as HTMLElement
    expect(pasta).not.toHaveClass('gdinner-plate')
    expect(pasta.querySelector('.cal-chev')).toBeNull()
    // still drills into the recipe, exactly as before
    expect(pasta.querySelector('.gdinner-chev')).toBeTruthy()
    expect(pasta.textContent).not.toContain('Meal ·')

    fireEvent.click(pasta)
    expect(rail.querySelectorAll('.gdish')).toHaveLength(0)
  })

  it('lists unscheduled plates and loose off-plan recipes under an Unscheduled heading, after Scheduled', async () => {
    mockBoardWithPlate({
      unscheduledMeals: [tacoNight],
      unscheduled: [{ recipeId: 'r2', title: 'Guacamole', emoji: '🥑', color: '#22A06B' }],
    })
    renderBoard()
    await screen.findByText('BBQ sauce')

    const rail = railCard()
    expect([...rail.querySelectorAll('.grocery-rail-sub')].map((e) => e.textContent)).toEqual(['Scheduled', 'Unscheduled'])

    const taco = within(rail).getByText('Taco Night').closest('.gdinner') as HTMLElement
    expect(taco).toHaveClass('gdinner-plate')
    expect(taco.textContent).toContain('Meal · 1')
    // an unscheduled plate has no day column — it belongs to no slot
    expect(taco.querySelector('.gdinner-day')).toBeNull()
    // the loose off-plan recipe still lists alongside it
    expect(within(rail).getByText('Guacamole')).toBeInTheDocument()
  })

  it('renders a dish of an unscheduled plate once, under its plate, not as a loose row', async () => {
    mockBoardWithPlate({
      unscheduledMeals: [tacoNight],
      // the server already drops it from `unscheduled`; be defensive if it doesn't
      unscheduled: [{ recipeId: 'd4', title: 'Carnitas', emoji: '🌮', color: '#22A06B' }],
    })
    renderBoard()
    await screen.findByText('BBQ sauce')

    const rail = railCard()
    expect(within(rail).queryByText('Carnitas')).not.toBeInTheDocument()
    fireEvent.click(within(rail).getByText('Taco Night'))
    expect(within(rail).getAllByText('Carnitas')).toHaveLength(1)
    expect(within(rail).getByText('Carnitas').closest('.gdinner')).toHaveClass('gdish')
  })
})

// "Add plate to list" was a one-way door: those rows are source='recipe', which the
// weekly rebuild never wipes, so a plate added off-plan stayed on the list forever
// with nothing anywhere to take it off.
describe('GroceryBoard — taking an unscheduled plate back off the list', () => {
  it('removes the plate without navigating into it', async () => {
    const sent: { method: string; url: string }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url)
      sent.push({ method: init?.method ?? 'GET', url: u })
      if (u.includes('/api/lists/grocery/board')) {
        return ok({
          list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 1 },
          weekStart: '2026-06-07',
          meals: [],
          unscheduled: [],
          unscheduledMeals: [tacoNight],
          items: [autoItem],
          staples: [],
        })
      }
      return ok({})
    }) as unknown as typeof fetch

    renderBoard()
    await screen.findByText('Tomatoes')
    const rail = railCard()
    fireEvent.click(within(rail).getByRole('button', { name: /Remove Taco Night/i }))

    await waitFor(() =>
      expect(
        sent.some((s) => s.method === 'DELETE' && /\/api\/meals\/M2\/add-to-list\?weekStart=2026-06-07$/.test(s.url)),
      ).toBe(true),
    )
    // the plate row itself must not have opened while we were aiming at its ×
    expect(rail.querySelectorAll('.gdish')).toHaveLength(0)
  })

  it('offers no such control for a SCHEDULED plate — that one comes off by unscheduling it', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')
    const rail = railCard()
    expect(within(rail).queryByRole('button', { name: /Remove BBQ Sunday/i })).not.toBeInTheDocument()
  })
})

describe('GroceryBoard per-meal provenance dots', () => {
  it('gives a plate’s item ONE dot in the plate’s colour, however many dishes credited it', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')

    const row = screen.getByText('BBQ sauce').closest('.gitem') as HTMLElement
    const dots = row.querySelectorAll('.gdot')
    expect(dots).toHaveLength(1)
    const plateDot = railCard().querySelector('.gdinner-plate .gdinner-c') as HTMLElement
    expect((dots[0] as HTMLElement).style.background).toBe(plateDot.style.background)
  })

  it('still colours a single-recipe slot’s item from its own recipe', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('Tomatoes')

    const row = screen.getByText('Tomatoes').closest('.gitem') as HTMLElement
    const dots = row.querySelectorAll('.gdot')
    expect(dots).toHaveLength(1)
    const plateDot = railCard().querySelector('.gdinner-plate .gdinner-c') as HTMLElement
    expect((dots[0] as HTMLElement).style.background).not.toBe(plateDot.style.background)
  })

  it('colours an unscheduled plate’s item from its sourceMealIds', async () => {
    const tacoItem = { ...plateItem, id: 'ti1', name: 'Tortillas', source: 'recipe', sourceRecipeIds: ['d4'], sourceMealIds: ['M2'] }
    mockBoardWithPlate({ unscheduledMeals: [tacoNight], items: [autoItem, tacoItem] })
    renderBoard()
    await screen.findByText('Tortillas')

    const row = screen.getByText('Tortillas').closest('.gitem') as HTMLElement
    const dots = row.querySelectorAll('.gdot')
    expect(dots).toHaveLength(1)
    const tacoDot = within(railCard()).getByText('Taco Night').closest('.gdinner')!.querySelector('.gdinner-c') as HTMLElement
    expect((dots[0] as HTMLElement).style.background).toBe(tacoDot.style.background)
  })
})

// The By-meal view groups items under the meal that wants them. A plate has
// recipeId null (its dish ids live in `recipes[]`), so grouping that only looks at
// `meals[].recipeId` skips plates entirely and dumps their shopping into the
// trailing "Other items" bucket — correct in the rail, wrong here.
describe('GroceryBoard By-meal grouping with plates', () => {
  it('groups a scheduled plate’s items under the plate, not "Other items"', async () => {
    mockBoardWithPlate()
    renderBoard()
    await screen.findByText('BBQ sauce')

    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    // The plate name also appears in the week rail, so scope to the grouped sections.
    const plateSection = screen
      .getAllByText('BBQ Sunday')
      .map((n) => n.closest('.grocery-section'))
      .find(Boolean) as HTMLElement
    expect(plateSection).toBeTruthy()
    expect(within(plateSection).getByText('BBQ sauce')).toBeInTheDocument()
    // and it must NOT have fallen through to the catch-all bucket
    expect(screen.queryByText('Other items')).not.toBeInTheDocument()
  })

  it('groups an unscheduled plate’s items under that plate too', async () => {
    const offPlate = {
      ...plateItem,
      id: 'pi2',
      name: 'Peaches',
      sourceRecipeIds: ['d9'],
      sourceMealIds: ['M2'],
    }
    mockBoardWithPlate({
      items: [offPlate],
      unscheduledMeals: [
        { mealId: 'M2', name: 'Cobbler Night', color: '#7A5AF8', recipes: [{ recipeId: 'd9', title: 'Peach Cobbler', emoji: '🥧', role: 'dessert' }] },
      ],
    })
    renderBoard()
    await screen.findByText('Peaches')

    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    const section = screen
      .getAllByText('Cobbler Night')
      .map((n) => n.closest('.grocery-section'))
      .find(Boolean) as HTMLElement
    expect(section).toBeTruthy()
    expect(within(section).getByText('Peaches')).toBeInTheDocument()
    expect(screen.queryByText('Other items')).not.toBeInTheDocument()
  })

  // A plate whose dishes all overlap an earlier group claims no rows of its own —
  // each item is listed once, under its first claimant. Dropping the section
  // entirely made the plate look like it had never been added, even though the
  // rail still listed it and the item dots still carried its colour.
  it('still shows a plate whose items were all claimed by an earlier meal, and says where they went', async () => {
    const shared = { ...plateItem, id: 'pi3', name: 'BBQ sauce', sourceRecipeIds: ['d1'], sourceMealIds: ['M2'] }
    mockBoardWithPlate({
      items: [shared],
      // M2's only dish is d1 — which is also on the SCHEDULED plate M1 (BBQ Sunday).
      unscheduledMeals: [
        { mealId: 'M2', name: 'Overlap Night', color: '#7A5AF8', recipes: [{ recipeId: 'd1', title: 'BBQ Chicken', emoji: '🍗', role: 'main' }] },
      ],
    })
    renderBoard()
    await screen.findByText('BBQ sauce')
    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    const section = screen
      .getAllByText('Overlap Night')
      .map((n) => n.closest('.grocery-section'))
      .find(Boolean) as HTMLElement
    expect(section).toBeTruthy()
    expect(section.textContent).toMatch(/listed under BBQ Sunday/i)
    // the row itself stays where it was — one item, one checkbox
    expect(within(section).queryByText('BBQ sauce')).not.toBeInTheDocument()
  })

  it('lets you take an unscheduled plate off the list from its section header', async () => {
    const offPlate = { ...plateItem, id: 'pi4', name: 'Peaches', sourceRecipeIds: ['d9'], sourceMealIds: ['M2'] }
    mockBoardWithPlate({
      items: [offPlate],
      unscheduledMeals: [
        { mealId: 'M2', name: 'Cobbler Night', color: '#7A5AF8', recipes: [{ recipeId: 'd9', title: 'Peach Cobbler', emoji: '🥧', role: 'dessert' }] },
      ],
    })
    renderBoard()
    await screen.findByText('Peaches')
    fireEvent.click(screen.getByRole('button', { name: 'By meal' }))

    const section = screen
      .getAllByText('Cobbler Night')
      .map((n) => n.closest('.grocery-section'))
      .find(Boolean) as HTMLElement
    expect(within(section).getByRole('button', { name: /Remove from list/i })).toBeInTheDocument()
  })
})
