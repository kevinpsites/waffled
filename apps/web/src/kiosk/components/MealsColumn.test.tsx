import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { MealsColumn, WeekDinnersCard, TonightCardSlot, isTryNew } from './MealsColumn'
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

// The Today card had the same blind spot as the planner grid: `clickable` was
// `!!e.recipeId`, so a night holding a whole plate rendered as dead text — no
// chevron, no tap target, no way through to the meal.
describe('MealsColumn — a night that holds a plate', () => {
  it('opens the plate rather than doing nothing', async () => {
    const today = localToday()
    mockWeek([
      {
        id: `${today}-d`,
        date: today,
        mealType: 'dinner',
        title: 'BBQ Sunday',
        recipeId: null,
        mealId: 'm1',
        recipe: null,
        meal: { id: 'm1', name: 'BBQ Sunday', servings: 6, recipes: [] },
      },
    ])
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<WeekDinnersCard />} />
          <Route path="/meals/build/:id" element={<div>BUILDER:m1</div>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /BBQ Sunday/i }))
    expect(await screen.findByText('BUILDER:m1')).toBeInTheDocument()
  })
})

describe('MealsColumn — Tonight is a whole plate', () => {
  it('offers the meal and its cook mode instead of "No recipe attached yet"', async () => {
    const today = localToday()
    mockWeek([
      {
        id: `${today}-d`,
        date: today,
        mealType: 'dinner',
        title: 'BBQ Sunday',
        recipeId: null,
        mealId: 'm1',
        recipe: null,
        meal: { id: 'm1', name: 'BBQ Sunday', servings: 6, recipes: [{ recipeId: 'r1', title: 'BBQ Chicken', emoji: '🍗', role: 'main', sortOrder: 0 }] },
      },
    ])
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<TonightCardSlot />} />
          <Route path="/meals/build/:id" element={<div>BUILDER</div>} />
          <Route path="/meals/meal/:id/cook" element={<div>COOK PLATE</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('BBQ Sunday')).toBeInTheDocument()
    expect(screen.queryByText(/No recipe attached yet/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Cook Mode/i }))
    expect(await screen.findByText('COOK PLATE')).toBeInTheDocument()
  })
})

