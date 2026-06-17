import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeModal } from './RecipeModal'

// RecipeView (inside the modal) uses useNavigate for its clickable metadata
// chips, so it needs a Router in the test tree.
function mockRecipe(recipe: Record<string, unknown>, ingredients: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      // RecipeView maps over these arrays unconditionally — supply them so the
      // mock matches the RecipeDetail contract.
      recipe: { dietary: [], vegetables: [], addedTags: [], tags: [], ...recipe },
      ingredients,
      steps: [],
    }),
  })) as unknown as typeof fetch
}

describe('RecipeModal', () => {
  it('shows the recipe with its ingredients, and closes', async () => {
    mockRecipe(
      {
        id: 'r',
        title: 'Chicken Parmesan',
        emoji: '🍗',
        description: null,
        prepTimeMinutes: 30,
        cookTimeMinutes: 50,
        servings: 4,
        sourceName: 'Joshua Weissman',
      },
      [
        { id: '1', name: 'flour', amount: 1.5, unit: 'cup', prepNote: null, section: 'Breading', isStaple: false, sub: null, sortOrder: 0 },
        { id: '2', name: 'salt', amount: null, unit: null, prepNote: null, section: 'Protein', isStaple: false, sub: null, sortOrder: 1 },
      ]
    )
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <RecipeModal recipeId="r" onClose={onClose} />
      </MemoryRouter>
    )

    expect(await screen.findByText('Chicken Parmesan')).toBeInTheDocument()
    // Ingredient rows render the scaled amount and the name in separate spans.
    expect(screen.getByText('1½ cup')).toBeInTheDocument()
    expect(screen.getByText('flour')).toBeInTheDocument()
    expect(screen.getByText('salt')).toBeInTheDocument()
    expect(screen.getByText(/Joshua Weissman/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close recipe'))
    expect(onClose).toHaveBeenCalled()
  })
})
