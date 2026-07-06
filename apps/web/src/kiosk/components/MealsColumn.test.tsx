import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { MealsColumn, isTryNew } from './MealsColumn'
import { localToday } from '../../lib/api'

// TonightCard uses useNavigate (View recipe / Cook Mode), so a router is needed.
const renderCol = () => render(<MealsColumn />, { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> })

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
    renderCol()
    // tonight's dinner also appears in the week list, so it shows twice
    expect(await screen.findAllByText('Ravioli Bake')).toHaveLength(2)
    expect(screen.getByText(/Serves 5/)).toBeInTheDocument() // tonight card only
    // week list
    expect(screen.getByText('Chorizo Tacos')).toBeInTheDocument()
    expect(screen.getByText(/2 planned/)).toBeInTheDocument()
  })

  it('drops the tonight card and shows the week empty state when nothing is planned', async () => {
    mockWeek([])
    renderCol()
    expect(await screen.findByText(/No dinners planned yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Tonight · Dinner/)).not.toBeInTheDocument()
  })

  it('shows a recipe-less dinner instead of hiding it, with a find-recipe action', async () => {
    const today = localToday()
    mockWeek([{ id: `${today}-d`, date: today, mealType: 'dinner', title: 'Fish', recipeId: null, recipe: null }])
    renderCol()
    expect(await screen.findAllByText('Fish')).toHaveLength(2) // tonight card + week list
    expect(screen.getByText(/No recipe attached yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Find a recipe/ })).toBeInTheDocument()
  })

  it('renders an eating-out night as "Eating out"', async () => {
    const today = localToday()
    mockWeek([{ id: `${today}-d`, date: today, mealType: 'dinner', title: 'Eating out', recipeId: null, recipe: null }])
    renderCol()
    expect(await screen.findAllByText('Eating out')).toHaveLength(2) // tonight card + week list
    expect(screen.getByText(/No cooking tonight/)).toBeInTheDocument()
  })

  it('renders a "Try something new" night with its label', async () => {
    const today = localToday()
    mockWeek([{ id: `${today}-d`, date: today, mealType: 'dinner', title: 'Try something new', recipeId: null, recipe: null }])
    renderCol()
    expect(await screen.findAllByText('Try something new')).toHaveLength(2) // tonight card + week list
    expect(screen.getByText(/brand-new dish/)).toBeInTheDocument()
  })
})

describe('isTryNew', () => {
  it('classifies a recipe-less "Try something new" entry', () => {
    expect(isTryNew({ recipeId: null, title: 'Try something new' })).toBe(true)
    expect(isTryNew({ recipeId: null, title: 'Try new recipe' })).toBe(true)
  })

  it('does not classify a real recipe or a leftovers night', () => {
    // A real recipe (has recipeId) even if its title happened to match.
    expect(isTryNew({ recipeId: 'r1', title: 'Try something new' })).toBe(false)
    expect(isTryNew({ recipeId: null, title: 'Leftovers' })).toBe(false)
    expect(isTryNew({ recipeId: null, title: 'Eating out' })).toBe(false)
  })
})
