import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider } from '../topbar-slot'

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

    // the off-plan recipe gets its own section, tagged as unscheduled
    const header = screen.getByText('Guacamole').closest('.grocery-section-h') as HTMLElement
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
    const guac = screen.getByText('Guacamole').closest('.grocery-section') as HTMLElement
    expect(guac.textContent).not.toContain('Limes')
    expect(guac.textContent).toContain('Avocados')
  })
})
