import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'

const mealieState = { connected: true, hasShoppingList: true, loading: false, refresh: () => {} }
vi.mock('../lib/mealie-context', () => ({ useMealie: () => mealieState }))
vi.mock('./MealieMeals', () => ({ MealieMeals: () => <div>mealie-meals</div> }))
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  useHousehold: () => ({ household: { timezone: 'UTC', weekStart: 'sunday' } }),
  useMealsWeek: () => ({ entries: [], loading: false, error: null }),
  useRecipes: () => ({ recipes: [], loading: false, error: null }),
}))

import { Meals } from './Meals'
import { NotWhenMealie } from './routes'

const routed = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="meals" element={<div>meals-home</div>} />
      <Route path="meals/recipes" element={<NotWhenMealie><div>builtin-recipes</div></NotWhenMealie>} />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => { mealieState.connected = true; mealieState.loading = false })

describe('Meals / NotWhenMealie swap', () => {
  it('Meals renders MealieMeals when connected', () => {
    render(<MemoryRouter><Meals /></MemoryRouter>)
    expect(screen.getByText('mealie-meals')).toBeTruthy()
  })

  it('Meals renders the built-in page when not connected', () => {
    mealieState.connected = false
    render(<MemoryRouter><Meals /></MemoryRouter>)
    expect(screen.queryByText('mealie-meals')).toBeNull()
  })

  it('redirects built-in routes to /meals while connected', () => {
    routed('/meals/recipes')
    expect(screen.getByText('meals-home')).toBeTruthy()
  })

  it('does not redirect when not connected', () => {
    mealieState.connected = false
    routed('/meals/recipes')
    expect(screen.getByText('builtin-recipes')).toBeTruthy()
  })

  it('renders nothing while loading', () => {
    mealieState.loading = true
    mealieState.connected = false
    routed('/meals/recipes')
    expect(screen.queryByText('builtin-recipes')).toBeNull()
    expect(screen.queryByText('meals-home')).toBeNull()
  })
})
