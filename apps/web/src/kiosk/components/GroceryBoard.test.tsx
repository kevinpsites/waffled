import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider, useTopbarSlots } from '../topbar-slot'

function TopbarProbe() {
  return <>{useTopbarSlots().full}</>
}

const kelly = { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' }

// A manual item a kid hand-added, and an auto item the meal builder generated.
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

    // auto (meal-builder) item reads as auto-generated, never "added by"
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

describe('GroceryBoard By-store view', () => {
  // Two spellings of one shop. The section header is uppercased in CSS, so leaving
  // these unfolded renders two identical-looking "COSTCO" sections.
  function mockStoreBoard() {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/lists/stores')) return ok({ stores: ['Costco'] })
      if (u.includes('/api/lists/grocery/board')) {
        return ok({
          list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 3 },
          weekStart: '2026-06-07',
          meals: [],
          items: [
            { ...manualItem, id: 's1', name: 'Rotisserie chicken', store: 'Costco' },
            { ...manualItem, id: 's2', name: 'Paper towels', store: 'costco' },
            { ...manualItem, id: 's3', name: 'Whole milk', store: 'Walmart' },
          ],
          staples: [],
        })
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
  }

  const storeHeaders = () =>
    [...document.querySelectorAll('.grocery-section-h')].map((el) => (el.textContent ?? '').replace(/[›\s]+/g, ' ').trim())

  it('folds differently-cased spellings of one store into a single section', async () => {
    mockStoreBoard()
    renderBoard()
    await screen.findByText('Rotisserie chicken')
    fireEvent.click(screen.getByRole('button', { name: 'By store' }))

    const costco = storeHeaders().filter((h) => /costco/i.test(h))
    expect(costco).toHaveLength(1)
    expect(costco[0]).toMatch(/2$/) // and it owns both items
  })

  it('still separates genuinely different stores', async () => {
    mockStoreBoard()
    renderBoard()
    await screen.findByText('Rotisserie chicken')
    fireEvent.click(screen.getByRole('button', { name: 'By store' }))

    expect(storeHeaders().filter((h) => /walmart/i.test(h))).toHaveLength(1)
  })
})

// The topbar "Share list" handoff: the board's unchecked items as aisle-grouped
// text, offered as copy / share sheet / QR so a phone can take the list to the shop.
describe('GroceryBoard share-list handoff', () => {
  function mockShareBoard() {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/lists/grocery/board')) {
        return ok({
          list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 3 },
          weekStart: '2026-06-07',
          meals: [{ date: '2026-06-08', mealType: 'dinner', recipeId: 'r1', title: 'Pasta', emoji: '🍝', color: '#1f5fd0' }],
          items: [
            { ...autoItem, id: 'p1', name: 'Asparagus', quantity: '2 bunch', aisle: 'Produce' },
            { ...autoItem, id: 'p2', name: 'Tomatoes', quantity: '2', aisle: 'Produce' },
            { ...manualItem, id: 'o1', name: 'Cookies' },
          ],
          staples: [],
        })
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
  }

  it('opens the share view with the unchecked items grouped by aisle', async () => {
    mockShareBoard()
    renderBoard()
    await screen.findByText('Asparagus')

    fireEvent.click(await screen.findByRole('button', { name: /Share list/ }))

    expect(screen.getByText('Share list', { selector: '.modal-card *' })).toBeInTheDocument()
    const block = document.querySelector('.share-list-text') as HTMLElement
    expect(block.textContent).toBe(
      ['PRODUCE', '- Asparagus (2 bunch)', '- Tomatoes (2)', '', 'OTHER', '- Cookies'].join('\n')
    )
  })
})
