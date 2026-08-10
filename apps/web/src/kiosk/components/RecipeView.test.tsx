import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeView } from './RecipeView'
import type { RecipeDetail, RecipeIngredient } from '../../lib/api'

// Drive the view off a fixed recipe by mocking the data hook + the write helpers
// it imports (never called in these read-only assertions, but referenced at module load).
const recipeRef: { current: RecipeDetail | null } = { current: null }
const ingredientsRef: { current: RecipeIngredient[] } = { current: [] }
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    useRecipe: () => ({ recipe: recipeRef.current, ingredients: ingredientsRef.current, steps: [], loading: false, error: false, refetch: () => {} }),
  }
})

function makeIngredient(over: Partial<RecipeIngredient> & { id: string; name: string }): RecipeIngredient {
  return {
    amount: 1,
    unit: null,
    prepNote: null,
    display: null,
    section: null,
    aisle: null,
    isStaple: false,
    sortOrder: null,
    sub: null,
    ...over,
  }
}

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
  // "Add to grocery" opens a picker so the shopper can add all or just the items they
  // need; the POST happens when they confirm inside the modal.
  beforeEach(() => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Guacamole' })
    ingredientsRef.current = [
      makeIngredient({ id: 'i1', name: 'avocado' }),
      makeIngredient({ id: 'i2', name: 'lime' }),
      makeIngredient({ id: 'i3', name: 'cilantro' }),
    ]
  })

  // Several controls share the "Add to grocery" handler, and the recipe body lists the
  // same ingredient names as the picker — so open via the first trigger and scope every
  // subsequent query to the modal card.
  async function openPicker() {
    fireEvent.click(screen.getAllByRole('button', { name: 'Add to grocery' })[0])
    const heading = await screen.findByText('Add to grocery list')
    return within(heading.closest('.modal-card') as HTMLElement)
  }

  it('always offers an "Add to grocery" action and posts the recipe to the grocery list', async () => {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return { ok: true, json: async () => ({ added: 3 }) }
    }) as unknown as typeof fetch
    renderView()

    // first-class action — present even when the on-hand banner has nothing "missing"
    // the picker opens with every non-staple ingredient pre-checked
    const modal = await openPicker()
    fireEvent.click(modal.getByRole('button', { name: 'Add 3 items' }))

    expect(await screen.findByText(/Added 3 items/)).toBeInTheDocument()
    const post = calls.find((c) => c.url.includes('/api/lists/grocery/from-recipe/r1'))
    expect(post).toBeTruthy()
    expect(post!.body).toEqual({ ingredientIds: ['i1', 'i2', 'i3'] })
  })

  it('adds only the ingredients left checked in the picker', async () => {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return { ok: true, json: async () => ({ added: 2 }) }
    }) as unknown as typeof fetch
    renderView()

    const modal = await openPicker()
    // uncheck the one they already have on hand
    fireEvent.click(modal.getByRole('button', { name: /lime/ }))
    fireEvent.click(modal.getByRole('button', { name: 'Add 2 items' }))

    expect(await screen.findByText(/Added 2 items/)).toBeInTheDocument()
    const post = calls.find((c) => c.url.includes('/api/lists/grocery/from-recipe/r1'))
    expect(post!.body).toEqual({ ingredientIds: ['i1', 'i3'] })
  })

  it('leaves pantry staples unchecked so they are not added by default', async () => {
    ingredientsRef.current = [
      makeIngredient({ id: 'i1', name: 'avocado' }),
      makeIngredient({ id: 'i2', name: 'salt', isStaple: true }),
    ]
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ added: 1 }) })) as unknown as typeof fetch
    renderView()

    // only the non-staple is pre-selected
    const modal = await openPicker()
    expect(modal.getByRole('button', { name: 'Add 1 item' })).toBeInTheDocument()
  })

  // The picker reuses `.ring-row` from the cooking checklist, where "on" means "already
  // got it" and is struck through. In the picker "on" means "will be added", so the two
  // must not share the struck-through treatment — see the `checklist` / `picking` split.
  it('does not give picked ingredients the checklist strike-through styling', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ added: 3 }) })) as unknown as typeof fetch
    renderView()

    const modal = await openPicker()
    const picked = modal.getByRole('button', { name: /avocado/ })
    expect(picked.className).toContain('picking')
    expect(picked.className).not.toContain('checklist')
  })

  it('shows an error note when the request fails instead of failing silently', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    renderView()

    const modal = await openPicker()
    fireEvent.click(modal.getByRole('button', { name: 'Add 3 items' }))

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
