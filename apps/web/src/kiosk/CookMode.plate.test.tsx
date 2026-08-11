import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { CookMode } from './CookMode'
import { TopbarSlotProvider } from './topbar-slot'

// Cooking a whole Meal Builder plate: one tab per dish, independent step progress
// per dish, and the single-recipe route left exactly as it was.

interface DishSpec {
  recipeId: string
  title: string
  emoji: string
  steps: string[]
}

function plateJson(name: string, dishes: DishSpec[]) {
  return {
    meal: {
      id: 'm1',
      name,
      servings: 4,
      isSaved: false,
      createdBy: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      recipeCount: dishes.length,
      emojis: dishes.map((d) => d.emoji),
      totalMinutes: null,
      onHand: null,
      toBuy: 0,
      recipes: dishes.map((d, k) => ({
        recipeId: d.recipeId,
        title: d.title,
        emoji: d.emoji,
        category: null,
        role: k === 0 ? 'main' : 'side',
        sortOrder: k,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        servings: null,
        imageUrl: null,
        cook: null,
        onHand: null,
        toBuy: 0,
      })),
    },
  }
}

// GET /api/meals/:id (the plate) + GET /api/recipes/:id for each dish on it.
function mockPlate(name: string, dishes: DishSpec[], ingredients: Record<string, string[]> = {}) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/api/meals/m1')) {
      return { ok: true, json: async () => plateJson(name, dishes) }
    }
    const dish = dishes.find((d) => u.endsWith(`/api/recipes/${d.recipeId}`))
    if (dish) {
      return {
        ok: true,
        json: async () => ({
          recipe: { id: dish.recipeId, title: dish.title, emoji: dish.emoji },
          ingredients: (ingredients[dish.recipeId] ?? []).map((name2, k) => ({
            id: `${dish.recipeId}-i${k}`,
            name: name2,
            amount: 1,
            unit: 'lb',
            sub: null,
          })),
          steps: dish.steps.map((instruction, k) => ({
            stepNumber: k + 1,
            instruction,
            ingredients: [],
            note: null,
            timerSeconds: null,
          })),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function mockSingleRecipe(steps: string[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/api/recipes/r1')) {
      return {
        ok: true,
        json: async () => ({
          recipe: { id: 'r1', title: 'Test Recipe' },
          ingredients: [],
          steps: steps.map((instruction, k) => ({
            stepNumber: k + 1,
            instruction,
            ingredients: [],
            note: null,
            timerSeconds: null,
          })),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipe/:id/cook" element={<CookMode />} />
          <Route path="/meals/meal/:id/cook" element={<CookMode />} />
          <Route path="/meals/recipe/:id" element={<div>recipe page</div>} />
          <Route path="/meals/build/:id" element={<div>plate page</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

const BBQ: DishSpec = {
  recipeId: 'r1',
  title: 'BBQ Chicken',
  emoji: '🍗',
  steps: ['Rub the chicken', 'Grill it', 'Rest it', 'Slice and serve'],
}
const SALAD: DishSpec = {
  recipeId: 'r2',
  title: 'Potato Salad',
  emoji: '🥔',
  steps: ['Boil the potatoes', 'Mix the dressing'],
}

describe('CookMode — cooking a plate', () => {
  it('renders one tab per dish with its emoji, title and its own progress', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].textContent).toContain('🍗')
    expect(tabs[0].textContent).toContain('BBQ Chicken')
    expect(tabs[0].textContent).toContain('Step 1 of 4')
    expect(tabs[1].textContent).toContain('🥔')
    expect(tabs[1].textContent).toContain('Potato Salad')
    expect(tabs[1].textContent).toContain('Step 1 of 2')
    // The first dish is the active one.
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
  })

  it('advances only the active dish — the other dish stays where it was', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('Grill it')
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('Rest it')

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].textContent).toContain('Step 3 of 4')
    expect(tabs[1].textContent).toContain('Step 1 of 2')
  })

  it('switching tabs returns each dish to exactly where it was left', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    // BBQ chicken → step 2.
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('Grill it')

    // Switch to the potato salad — it starts at its own step 1.
    fireEvent.click(screen.getAllByRole('tab')[1])
    await screen.findByText('Boil the potatoes')
    expect(screen.queryByText('Grill it')).toBeNull()

    // Advance the salad to its step 2 (its last).
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('Mix the dressing')

    // Back to the chicken — still on step 2, where we left it.
    fireEvent.click(screen.getAllByRole('tab')[0])
    await screen.findByText('Grill it')
    expect(screen.getAllByRole('tab')[0].textContent).toContain('Step 2 of 4')
    expect(screen.getAllByRole('tab')[1].textContent).toContain('Step 2 of 2')

    // And back to the salad — still on its step 2.
    fireEvent.click(screen.getAllByRole('tab')[1])
    await screen.findByText('Mix the dressing')
  })

  it('the ingredients panel follows the active dish', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD], { r1: ['chicken thighs'], r2: ['yukon golds'] })
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    fireEvent.click(screen.getByRole('button', { name: /all ingredients/i }))
    await screen.findByText('chicken thighs')
    expect(screen.queryByText('yukon golds')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    fireEvent.click(screen.getAllByRole('tab')[1])
    await screen.findByText('Boil the potatoes')
    fireEvent.click(screen.getByRole('button', { name: /all ingredients/i }))
    await screen.findByText('yukon golds')
    expect(screen.queryByText('chicken thighs')).toBeNull()
  })

  it('renders an empty state for a plate with no dishes instead of crashing', async () => {
    mockPlate('Empty Plate', [])
    renderAt('/meals/meal/m1/cook')
    expect(await screen.findByText(/nothing on this plate/i)).toBeTruthy()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('renders a friendly message when the plate cannot be loaded', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch
    renderAt('/meals/meal/m1/cook')
    expect(await screen.findByText(/isn’t available/i)).toBeTruthy()
  })
})

describe('CookMode — single-recipe route is unchanged', () => {
  it('renders no tab strip when cooking one recipe', async () => {
    mockSingleRecipe(['Chop the onions', 'Heat the pan'])
    renderAt('/meals/recipe/r1/cook')
    await screen.findByText('Chop the onions')

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    // …and still steps through as it always has.
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('Heat the pan')
  })

  it('still shows the no-steps message for a recipe with no steps', async () => {
    mockSingleRecipe([])
    renderAt('/meals/recipe/r1/cook')
    expect(await screen.findByText(/no steps recorded/i)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })
})
