import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider } from '../topbar-slot'

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
        <GroceryBoard onBack={() => {}} />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('GroceryBoard item attribution', () => {
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
