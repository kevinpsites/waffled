import { render, screen, fireEvent } from '@testing-library/react'
import { RecipeModal } from './RecipeModal'

function mockRecipe(recipe: unknown, ingredients: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ recipe, ingredients }),
  })) as unknown as typeof fetch
}

describe('RecipeModal', () => {
  it('shows the recipe with ingredients grouped by section, and closes', async () => {
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
        { id: '1', name: 'flour', amount: 1.5, unit: 'cup', prepNote: null, display: '1½ cups (225g) flour', section: 'Breading', sortOrder: 0 },
        { id: '2', name: 'salt', amount: null, unit: null, prepNote: null, display: 'Kosher salt, to taste', section: 'Protein', sortOrder: 1 },
      ]
    )
    const onClose = vi.fn()
    render(<RecipeModal recipeId="r" onClose={onClose} />)

    expect(await screen.findByText('Chicken Parmesan')).toBeInTheDocument()
    expect(screen.getByText('1½ cups (225g) flour')).toBeInTheDocument()
    expect(screen.getByText('Breading')).toBeInTheDocument()
    expect(screen.getByText(/Joshua Weissman/)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close recipe'))
    expect(onClose).toHaveBeenCalled()
  })
})
