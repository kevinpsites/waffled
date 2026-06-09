import { render, screen } from '@testing-library/react'
import { MealsColumn } from './MealsColumn'
import { localToday } from '../../lib/api'

function mockWeek(entries: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ start: localToday(), entries }),
  })) as unknown as typeof fetch
}

function dinner(date: string, title: string, emoji: string, extra: object = {}) {
  return {
    id: `${date}-d`,
    date,
    mealType: 'dinner',
    title: null,
    recipeId: 'r',
    recipe: { title, emoji, prepTimeMinutes: null, cookTimeMinutes: 35, servings: 5, imageUrl: null, ...extra },
  }
}

describe('MealsColumn', () => {
  it("shows tonight's dinner and the week's dinners", async () => {
    const today = localToday()
    mockWeek([dinner(today, 'Ravioli Bake', '🍝'), dinner('2026-12-31', 'Chorizo Tacos', '🌮')])
    render(<MealsColumn />)
    // tonight's dinner also appears in the week list, so it shows twice
    expect(await screen.findAllByText('Ravioli Bake')).toHaveLength(2)
    expect(screen.getByText(/Serves 5/)).toBeInTheDocument() // tonight card only
    // week list
    expect(screen.getByText('Chorizo Tacos')).toBeInTheDocument()
    expect(screen.getByText('2 planned')).toBeInTheDocument()
  })

  it('shows empty states when nothing is planned', async () => {
    mockWeek([])
    render(<MealsColumn />)
    expect(await screen.findByText(/Nothing planned for tonight/)).toBeInTheDocument()
    expect(screen.getByText(/No dinners planned yet/)).toBeInTheDocument()
  })
})
