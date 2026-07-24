import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useParams } from 'react-router'
import { RecipeView } from './RecipeView'
import type { RecipeDetail, RecipeIngredient, Meal, OnHandCount } from '../../lib/api'

// Two things under test here, both from the Meal Builder plan:
//  * the on-hand banner must use the REAL pantry-derived counts the API now returns
//    (`onHand: {have,total} | null`) instead of counting `isStaple` ingredients —
//    the latent bug called out in decision 5;
//  * "Build a meal around this" seeds a new plate from the recipe (decision 11).
const recipeRef: { current: RecipeDetail | null } = { current: null }
const ingredientsRef: { current: RecipeIngredient[] } = { current: [] }
const onHandRef: { current: OnHandCount | null } = { current: null }
const toBuyRef: { current: number } = { current: 0 }

const createMock = vi.fn(async (input: { name: string; servings?: number }): Promise<Meal> => ({
  id: 'm-new',
  name: input.name,
  servings: input.servings ?? 4,
  isSaved: false,
  createdBy: null,
  createdAt: '2026-07-23T00:00:00.000Z',
  recipeCount: 0,
  emojis: [],
  totalMinutes: null,
  onHand: null,
  toBuy: 0,
  recipes: [],
}))
const addDishMock = vi.fn(async (_mealId: string, _input: { recipeId: string; role?: string }) => ({}) as Meal)
const recipeFetchMock = vi.fn(async (_id?: string) => ({
  recipe: recipeRef.current,
  ingredients: ingredientsRef.current,
  steps: [],
  onHand: onHandRef.current,
  toBuy: toBuyRef.current,
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    // The counts ride along on useRecipe now — they come off the same
    // GET /api/recipes/:id the screen already makes, rather than a second request.
    useRecipe: () => ({
      recipe: recipeRef.current,
      ingredients: ingredientsRef.current,
      steps: [],
      onHand: onHandRef.current,
      toBuy: toBuyRef.current,
      loading: false,
      error: false,
      refetch: () => {},
    }),
    // Wrapped in arrows: a vi.mock factory is hoisted above the const declarations
    // above, so it may only *reference* them lazily, never read them at build time.
    mealsApi: {
      ...actual.mealsApi,
      recipe: (rid: string) => recipeFetchMock(rid),
      recipeMarkdown: async () => ({ markdown: '# x', filename: 'x.md' }),
    },
    mealBuilderApi: {
      ...actual.mealBuilderApi,
      create: (input: { name: string; servings?: number }) => createMock(input),
      addDish: (mid: string, input: { recipeId: string; role?: string }) => addDishMock(mid, input),
    },
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

function ing(name: string, isStaple: boolean, i: number): RecipeIngredient {
  return { id: `i${i}`, name, amount: null, unit: null, prepNote: null, section: null, isStaple, sub: null, sortOrder: i, display: name, aisle: null }
}

function Probe() {
  const { id } = useParams()
  return <div>{`BUILDER:${id}`}</div>
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipe/r1']}>
      <Routes>
        <Route path="/meals/recipe/:rid" element={<RecipeView id="r1" fullScreen />} />
        <Route path="/meals/build/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  createMock.mockClear()
  addDishMock.mockClear()
  recipeFetchMock.mockClear()
  recipeRef.current = makeDetail({ id: 'r1', title: 'Chicken Parmesan', servings: 6 })
  // 4 staples of 9 — the old, wrong banner would read "4 of 9 on hand" off these.
  ingredientsRef.current = [
    ...['salt', 'pepper', 'olive oil', 'flour'].map((n, i) => ing(n, true, i)),
    ...['chicken', 'mozzarella', 'basil', 'passata', 'breadcrumbs'].map((n, i) => ing(n, false, i + 4)),
  ]
  onHandRef.current = null
  toBuyRef.current = 0
})

describe('RecipeView — on-hand banner uses real pantry counts', () => {
  it('renders the pantry-derived counts the API supplies', async () => {
    onHandRef.current = { have: 2, total: 9 }
    toBuyRef.current = 3
    renderView()
    expect(await screen.findByText('2 of 9')).toBeInTheDocument()
    expect(screen.getByText(/on hand/i)).toBeInTheDocument()
    // …and NOT the old staple proxy.
    expect(screen.queryByText('4 of 9')).not.toBeInTheDocument()
  })

  it('renders no on-hand claim at all when the pantry module is off', async () => {
    // `onHand: null` means "we can't say". Not "0 of 9" (untrue), and definitely
    // not the staple count (the bug). Nothing at all.
    onHandRef.current = null
    toBuyRef.current = 5
    renderView()
    // The counts arrive with the recipe now, so awaiting the rendered banner is the
    // whole wait — there's no second request to synchronise against.
    expect(await screen.findByText(/5 to buy/)).toBeInTheDocument()
    expect(screen.queryByText(/on hand/i)).not.toBeInTheDocument()
    expect(screen.queryByText('0 of 9')).not.toBeInTheDocument()
    expect(screen.queryByText('4 of 9')).not.toBeInTheDocument()
  })

  it('keeps the "N to buy" count working with the pantry off', async () => {
    onHandRef.current = null
    toBuyRef.current = 5
    renderView()
    expect(await screen.findByText(/5 to buy/)).toBeInTheDocument()
  })

  it('shows nothing when there is neither an on-hand count nor anything to buy', async () => {
    onHandRef.current = null
    toBuyRef.current = 0
    renderView()
    await waitFor(() => expect(screen.queryByText(/on hand/i)).not.toBeInTheDocument())
    expect(screen.queryByText(/to buy/i)).not.toBeInTheDocument()
  })
})

describe('RecipeView — Build a meal around this', () => {
  it('seeds a new plate from the recipe and opens the builder', async () => {
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: /Build a meal around this/i }))
    await waitFor(() => expect(createMock).toHaveBeenCalled())
    // named after the recipe, carrying its servings
    expect(createMock.mock.calls[0][0]).toMatchObject({ name: 'Chicken Parmesan', servings: 6 })
    await waitFor(() => expect(addDishMock).toHaveBeenCalled())
    expect(addDishMock.mock.calls[0]).toEqual(['m-new', { recipeId: 'r1', role: 'main' }])
    expect(await screen.findByText('BUILDER:m-new')).toBeInTheDocument()
  })

  it('adds a dessert recipe in its natural role', async () => {
    recipeRef.current = makeDetail({ id: 'r1', title: 'Peach Cobbler', servings: 8, category: 'dessert' })
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: /Build a meal around this/i }))
    await waitFor(() => expect(addDishMock).toHaveBeenCalled())
    expect(addDishMock.mock.calls[0][1]).toMatchObject({ role: 'dessert' })
  })
})
