import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipesLibrary } from './RecipesLibrary'
import { TopbarSlotProvider } from './topbar-slot'
import type { Recipe } from '../lib/api'

// The "Recently viewed" rail: a shortcut back to what you just had open, above the
// library proper. Both data hooks are mocked so the rail can be driven independently
// of the (much larger) library list.
const recipesRef: { current: Recipe[] } = { current: [] }
const recentRef: { current: Recipe[] } = { current: [] }
const scopeRef: { current: string } = { current: 'me' }
const setScope = vi.fn((s: string) => {
  scopeRef.current = s
})

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    useRecipes: () => ({ recipes: recipesRef.current, loading: false, error: false }),
    useRecentRecipes: () => ({
      recipes: recentRef.current,
      loading: false,
      error: false,
      scope: scopeRef.current,
      setScope,
    }),
  }
})

function makeRecipe(over: Partial<Recipe> & { id: string; title: string }): Recipe {
  return {
    emoji: null, description: null, category: null, tags: null,
    prepTimeMinutes: null, cookTimeMinutes: null, servings: 4,
    imageUrl: null, storageKey: null, sourceName: null, isFavorite: false,
    cookedCount: 0, lastCookedAt: null, mealType: null, protein: null,
    base: null, cuisine: null, effort: null, cookMethod: null,
    flavorProfile: null, dietary: [], vegetables: [], collection: null,
    ...over,
  }
}

function renderLib() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipes']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipes" element={<RecipesLibrary />} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

const rail = (): HTMLElement => screen.getByTestId('recent-recipes')

describe('RecipesLibrary — recently viewed rail', () => {
  beforeEach(() => {
    setScope.mockClear()
    scopeRef.current = 'me'
    recipesRef.current = [
      makeRecipe({ id: 'a', title: 'Fresh Salad' }),
      makeRecipe({ id: 'b', title: 'Old Faithful Stew' }),
    ]
    recentRef.current = [
      makeRecipe({ id: 'b', title: 'Old Faithful Stew' }),
      makeRecipe({ id: 'a', title: 'Fresh Salad' }),
    ]
  })

  it('lists the recently viewed recipes in the order the server returned', () => {
    renderLib()
    const titles = within(rail())
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t && /Salad|Stew/.test(t))
    expect(titles[0]).toContain('Old Faithful Stew')
    expect(titles[1]).toContain('Fresh Salad')
  })

  // A brand-new household has no history; an empty strip with a heading is worse
  // than no strip at all.
  it('renders nothing at all when there is no history yet', () => {
    recentRef.current = []
    renderLib()
    expect(screen.queryByTestId('recent-recipes')).not.toBeInTheDocument()
  })

  it('offers a switch between my history and the household’s', () => {
    renderLib()
    fireEvent.click(within(rail()).getByRole('button', { name: /Everyone/i }))
    expect(setScope).toHaveBeenCalledWith('household')
  })

  // The rail is a shortcut, not a second library — tapping goes straight to the
  // recipe rather than filtering the list below.
  it('navigates to the recipe when one is tapped', () => {
    render(
      <MemoryRouter initialEntries={['/meals/recipes']}>
        <TopbarSlotProvider>
          <Routes>
            <Route path="/meals/recipes" element={<RecipesLibrary />} />
            <Route path="/meals/recipe/:id" element={<div>opened recipe</div>} />
          </Routes>
        </TopbarSlotProvider>
      </MemoryRouter>,
    )
    const card = within(rail()).getAllByRole('button').find((b) => b.textContent?.includes('Fresh Salad'))!
    fireEvent.click(card)
    expect(screen.getByText('opened recipe')).toBeInTheDocument()
  })
})
