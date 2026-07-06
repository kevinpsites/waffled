import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipesLibrary } from './RecipesLibrary'
import { TopbarSlotProvider } from './topbar-slot'
import type { Recipe } from '../lib/api'

// Drive the library off a fixed recipe set by mocking the data hook; everything
// else in the api slice stays real (the component only reads useRecipes here).
const recipesRef: { current: Recipe[] } = { current: [] }
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, useRecipes: () => ({ recipes: recipesRef.current, loading: false, error: false }) }
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

function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest('button.recipes-card') as HTMLElement
}

describe('RecipesLibrary — New / never-cooked filter', () => {
  beforeEach(() => {
    recipesRef.current = [
      makeRecipe({ id: 'a', title: 'Fresh Salad', cookedCount: 0 }),
      makeRecipe({ id: 'b', title: 'Old Faithful Stew', cookedCount: 5 }),
    ]
  })

  it('shows both cooked and never-cooked recipes with the New toggle off', () => {
    renderLib()
    expect(screen.getByText('Fresh Salad')).toBeInTheDocument()
    expect(screen.getByText('Old Faithful Stew')).toBeInTheDocument()
  })

  it('shows only never-cooked recipes when the New toggle is on', () => {
    renderLib()
    fireEvent.click(screen.getByRole('button', { name: /New/i }))
    expect(screen.getByText('Fresh Salad')).toBeInTheDocument()
    expect(screen.queryByText('Old Faithful Stew')).not.toBeInTheDocument()
  })

  it('renders the 🆕 badge only on never-cooked cards', () => {
    renderLib()
    expect(within(cardFor('Fresh Salad')).getByText('🆕')).toBeInTheDocument()
    expect(within(cardFor('Old Faithful Stew')).queryByText('🆕')).not.toBeInTheDocument()
  })
})
