import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useParams } from 'react-router'
import { RecipesLibrary } from './RecipesLibrary'
import { TopbarSlotProvider } from './topbar-slot'
import type { Recipe, Meal } from '../lib/api'

// A saved meal is a first-class citizen of the library (decision 11), so the list
// is fed by two sources: the recipes hook and the saved-meal hook. Both are mocked
// here; `savedQueries` records what the meal search was actually asked for, which
// is how we prove the search spans meals instead of being re-filtered client-side.
const recipesRef: { current: Recipe[] } = { current: [] }
const mealsRef: { current: Meal[] } = { current: [] }
const savedQueries: Array<string | undefined> = []

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    useRecipes: () => ({ recipes: recipesRef.current, loading: false, error: false }),
    useSavedMeals: (q?: string) => {
      savedQueries.push(q)
      return { meals: mealsRef.current, loading: false, error: false, refetch: () => {} }
    },
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
    recipes: [],
    ...over,
  }
}

function Probe({ label }: { label: string }) {
  const { id } = useParams()
  return <div>{`${label}:${id}`}</div>
}

function renderLib() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipes']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipes" element={<RecipesLibrary />} />
          <Route path="/meals/build/:id" element={<Probe label="BUILDER" />} />
          <Route path="/meals/recipe/:id" element={<Probe label="RECIPE" />} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest('.recipes-card') as HTMLElement
}

describe('RecipesLibrary — saved meals are first-class library citizens', () => {
  beforeEach(() => {
    savedQueries.length = 0
    recipesRef.current = [makeRecipe({ id: 'r1', title: 'Chicken Parmesan' })]
    mealsRef.current = [makeMeal({ id: 'm1', name: 'BBQ Sunday' })]
  })

  it('lists saved meals alongside recipes', () => {
    renderLib()
    expect(screen.getByText('BBQ Sunday')).toBeInTheDocument()
    expect(screen.getByText('Chicken Parmesan')).toBeInTheDocument()
  })

  it('badges a meal so it can never be mistaken for a recipe, and shows its dish emojis', () => {
    renderLib()
    const card = cardFor('BBQ Sunday')
    // "Meal · 4" — the type badge plus the dish count.
    expect(within(card).getByText('Meal · 4')).toBeInTheDocument()
    expect(within(card).getByText('🍗')).toBeInTheDocument()
    expect(within(card).getByText('🥧')).toBeInTheDocument()
    // …and a recipe card carries no such badge.
    expect(within(cardFor('Chicken Parmesan')).queryByText(/^Meal · /)).not.toBeInTheDocument()
  })

  it('opens the builder (which doubles as meal detail on web) when a meal is selected', () => {
    renderLib()
    fireEvent.click(cardFor('BBQ Sunday'))
    expect(screen.getByText('BUILDER:m1')).toBeInTheDocument()
  })

  it('still opens the recipe detail when a recipe is selected', () => {
    renderLib()
    fireEvent.click(cardFor('Chicken Parmesan'))
    expect(screen.getByText('RECIPE:r1')).toBeInTheDocument()
  })

  it('hands the search text to the saved-meal API and trusts its result', async () => {
    // The server's `q` matches the plate name OR any dish title, so "chicken"
    // legitimately returns "BBQ Sunday" (BBQ Chicken is one of its dishes). The
    // client must NOT re-filter that away against the plate name.
    renderLib()
    fireEvent.change(screen.getByLabelText(/^Search recipes/i), { target: { value: 'chicken' } })
    await waitFor(() => expect(savedQueries).toContain('chicken'))
    expect(screen.getByText('BBQ Sunday')).toBeInTheDocument()
    expect(screen.getByText('Chicken Parmesan')).toBeInTheDocument()
  })

  it('counts meals and recipes together in the result count', () => {
    renderLib()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })

  it('drops meals when a recipe-only structured filter is on (they carry no protein/cuisine)', () => {
    renderLib()
    fireEvent.click(screen.getByRole('button', { name: /Favorites/i }))
    expect(screen.queryByText('BBQ Sunday')).not.toBeInTheDocument()
  })
})
