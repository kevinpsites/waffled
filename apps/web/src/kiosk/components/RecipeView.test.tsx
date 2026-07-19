import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeView } from './RecipeView'
import type { RecipeDetail } from '../../lib/api'

// Drive the view off a fixed recipe by mocking the data hook + the write helpers
// it imports (never called in these read-only assertions, but referenced at module load).
const recipeRef: { current: RecipeDetail | null } = { current: null }
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    useRecipe: () => ({ recipe: recipeRef.current, ingredients: [], steps: [], loading: false, error: false, refetch: () => {} }),
  }
})

function makeDetail(over: Partial<RecipeDetail> & { id: string; title: string }): RecipeDetail {
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
    notes: null,
    userNotes: null,
    addedTags: [],
    overrides: {},
    ...over,
  }
}

function renderView() {
  return render(
    <MemoryRouter>
      <RecipeView id="r1" />
    </MemoryRouter>,
  )
}

describe('RecipeView — add ingredients to grocery', () => {
  it('always offers an "Add to grocery" action and posts the recipe to the grocery list', async () => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Guacamole' })
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(String(url))
      return { ok: true, json: async () => ({ added: 3 }) }
    }) as unknown as typeof fetch
    renderView()

    // first-class action — present even when the on-hand banner has nothing "missing"
    const btn = screen.getByRole('button', { name: 'Add to grocery' })
    fireEvent.click(btn)
    expect(await screen.findByText(/Added 3 items/)).toBeInTheDocument()
    expect(calls.some((u) => u.includes('/api/lists/grocery/from-recipe/r1'))).toBe(true)
  })

  it('shows an error note when the request fails instead of failing silently', async () => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Guacamole' })
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Add to grocery' }))
    expect(await screen.findByText(/Couldn’t reach the grocery list/)).toBeInTheDocument()
  })
})

describe('RecipeView — New tag', () => {
  it('shows the 🆕 New tag when the recipe has never been cooked', () => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Fresh Salad', cookedCount: 0 })
    renderView()
    expect(screen.getByRole('button', { name: /🆕 New/ })).toBeInTheDocument()
  })

  it('hides the 🆕 New tag once the recipe has been cooked', () => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Old Faithful Stew', cookedCount: 3 })
    renderView()
    expect(screen.queryByRole('button', { name: /🆕 New/ })).not.toBeInTheDocument()
  })
})
