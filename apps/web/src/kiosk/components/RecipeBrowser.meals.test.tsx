import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeBrowser } from './RecipeBrowser'
import type { Recipe, Meal } from '../../lib/api'

// The picker fills a meal-plan slot. A whole saved plate can go on Tuesday dinner
// without a builder round-trip (decision 11), so the browser lists saved meals
// beside recipes — but only when the caller can actually act on one, because the
// date lives in the caller's closure, not in this component.
const listMock = vi.fn(async (_q?: string): Promise<Meal[]> => mealsRef.current)
const mealsRef: { current: Meal[] } = { current: [] }

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    mealBuilderApi: { ...actual.mealBuilderApi, list: (q?: string) => listMock(q) },
  }
})

function makeRecipe(over: Partial<Recipe> & { id: string; title: string }): Recipe {
  return {
    emoji: null,
    description: null,
    category: null,
    tags: null,
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    servings: 4,
    imageUrl: null,
    storageKey: null,
    sourceName: null,
    isFavorite: false,
    cookedCount: 0,
    lastCookedAt: null,
    mealType: null,
    protein: null,
    base: null,
    cuisine: null,
    effort: null,
    cookMethod: null,
    flavorProfile: null,
    dietary: [],
    vegetables: [],
    collection: null,
    ...over,
  }
}

function makeMeal(over: Partial<Meal> & { id: string; name: string }): Meal {
  return {
    servings: 6,
    isSaved: true,
    createdBy: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    recipeCount: 4,
    emojis: ['🍗', '🥔', '🥬', '🥧'],
    totalMinutes: 90,
    onHand: null,
    toBuy: 0,
    toBuyNames: [],
    recipes: [],
    ...over,
  }
}

const RECIPES = [makeRecipe({ id: 'r1', title: 'Chicken Parmesan' })]

function renderBrowser(props: Partial<React.ComponentProps<typeof RecipeBrowser>> = {}) {
  return render(
    <MemoryRouter>
      <RecipeBrowser recipes={RECIPES} loading={false} slot="dinner" {...props} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  listMock.mockClear()
  mealsRef.current = [makeMeal({ id: 'm1', name: 'BBQ Sunday' })]
})

describe('RecipeBrowser — saved meals in the slot picker', () => {
  it('offers saved meals beside recipes when the caller can schedule a plate', async () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    expect(await screen.findByText('BBQ Sunday')).toBeInTheDocument()
    expect(screen.getByText('Chicken Parmesan')).toBeInTheDocument()
  })

  it('badges a meal card so a plate is never mistaken for a single recipe', async () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    const card = (await screen.findByText('BBQ Sunday')).closest('.mp-card') as HTMLElement
    expect(within(card).getByText('Meal · 4')).toBeInTheDocument()
    expect(within(card).getByText('🍗')).toBeInTheDocument()
  })

  it('hands the whole plate back to the caller when a meal is selected', async () => {
    const onPickMeal = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal })
    const card = (await screen.findByText('BBQ Sunday')).closest('.mp-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /Select/i }))
    expect(onPickMeal).toHaveBeenCalledTimes(1)
    expect(onPickMeal.mock.calls[0][0]).toMatchObject({ id: 'm1', name: 'BBQ Sunday' })
  })

  it('never asks for meals when the caller has nowhere to put one', async () => {
    // Plan-my-week / plan-my-month overlays hold a *draft* plan and don't persist a
    // pick, so they don't pass onPickMeal — no meal fetch, no meal cards.
    renderBrowser({ onPick: () => {} })
    expect(await screen.findByText('Chicken Parmesan')).toBeInTheDocument()
    expect(screen.queryByText('BBQ Sunday')).not.toBeInTheDocument()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('leaves the leftovers / eating-out / try-something-new placeholders exactly as they were', async () => {
    const onLeftovers = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal: () => {}, onEatingOut: () => {}, onLeftovers, onTrySomething: () => {} })
    expect(await screen.findByText('BBQ Sunday')).toBeInTheDocument()
    expect(screen.getByText('Eating out')).toBeInTheDocument()
    expect(screen.getByText('Try something new')).toBeInTheDocument()
    const card = screen.getByText('Leftovers').closest('.mp-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /Select/i }))
    expect(onLeftovers).toHaveBeenCalled()
  })

  it('asks the server to search meals rather than re-filtering the plate name locally', async () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    await screen.findByText('BBQ Sunday')
    fireEvent.change(screen.getByPlaceholderText(/Search recipes/i), { target: { value: 'chicken' } })
    // "chicken" matches a dish title on BBQ Sunday server-side; the card must stay.
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('chicken'))
    expect(await screen.findByText('BBQ Sunday')).toBeInTheDocument()
  })
})
