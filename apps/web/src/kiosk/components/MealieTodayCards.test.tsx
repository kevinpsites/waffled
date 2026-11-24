import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { ApiSendError } from '../../lib/api/client'

const mealplan = vi.fn()
const shopping = vi.fn()
const mealieState = { connected: true, hasShoppingList: true, loading: false, refresh: () => {} }

vi.mock('../../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/mealie')>()),
  mealieApi: { mealplan: (...a: unknown[]) => mealplan(...a), shopping: () => shopping() },
}))
vi.mock('../../lib/mealie-context', () => ({ useMealie: () => mealieState }))
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  useHousehold: () => ({ household: { timezone: 'UTC' }, person: null, memberships: [], pendingInvites: [] }),
  useMealsWeek: () => ({ entries: [], loading: false, error: null }),
  useGrocery: () => ({ items: [], loading: false, error: null, add: vi.fn(), toggle: vi.fn(), remove: vi.fn() }),
}))

import { TonightCardSlot, WeekDinnersCard } from './MealsColumn'
import { GroceryCard } from './GroceryCard'

const Where = () => <div data-testid="where">{useLocation().pathname}</div>
const wrap = (ui: React.ReactElement) =>
  render(<MemoryRouter><Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes></MemoryRouter>)

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date())
const entry = (id: number, entryType: string, title: string, slug: string | null, date = today) => ({
  id, date, entryType, title,
  recipe: slug ? { id: `r${id}`, slug, name: title, imageUrl: slug ? `/img/${slug}.webp` : null } : null,
})
const unavailable = new ApiSendError('GET', '/x', 502, { error: 'MealieUnavailable', message: 'x' })

beforeEach(() => {
  mealieState.connected = true
  mealieState.loading = false
  mealplan.mockReset()
  shopping.mockReset()
})

describe('MealieTonightCard', () => {
  it("shows today's dinner with image and name, and navigates to the cook view", async () => {
    mealplan.mockResolvedValue({ entries: [entry(1, 'dinner', 'Lasagna', 'lasagna'), entry(2, 'lunch', 'Soup', 'soup')] })
    const { container } = wrap(<TonightCardSlot />)
    fireEvent.click(await screen.findByText('Lasagna'))
    expect(screen.queryByText('Soup')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/img/lasagna.webp')
    expect(screen.getByTestId('where').textContent).toBe('/meals/mealie/lasagna')
  })

  it('falls back to all of today when there is no dinner', async () => {
    mealplan.mockResolvedValue({ entries: [entry(2, 'lunch', 'Soup', 'soup')] })
    wrap(<TonightCardSlot />)
    expect(await screen.findByText('Soup')).toBeTruthy()
  })

  it('renders nothing when nothing is planned', async () => {
    mealplan.mockResolvedValue({ entries: [] })
    const { container } = wrap(<TonightCardSlot />)
    await waitFor(() => expect(mealplan).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(container.querySelector('.card')).toBeNull()
  })

  it('does not make a title-only entry tappable', async () => {
    mealplan.mockResolvedValue({ entries: [entry(3, 'dinner', 'Leftovers', null)] })
    wrap(<TonightCardSlot />)
    fireEvent.click(await screen.findByText('Leftovers'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTestId('where').textContent).toBe('/')
  })

  it('shows a compact error when Mealie is unavailable', async () => {
    mealplan.mockRejectedValue(unavailable)
    wrap(<TonightCardSlot />)
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
  })

  it('renders nothing while the connection is loading', () => {
    mealieState.loading = true
    const { container } = wrap(<TonightCardSlot />)
    expect(container.querySelector('.card')).toBeNull()
    expect(mealplan).not.toHaveBeenCalled()
  })
})

describe('MealieWeekCard', () => {
  it('lists 7 days from household today with their entries', async () => {
    const d2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
    mealplan.mockResolvedValue({ entries: [entry(1, 'dinner', 'Lasagna', 'lasagna'), entry(2, 'dinner', 'Tacos', 'tacos', d2)] })
    const { container } = wrap(<WeekDinnersCard />)
    await screen.findByText('Lasagna')
    expect(container.querySelectorAll('[data-day]').length).toBe(7)
    expect(container.querySelector('[data-day]')?.getAttribute('data-day')).toBe(today)
    expect(container.querySelector(`[data-day="${d2}"]`)?.textContent).toContain('Tacos')
    expect(mealplan.mock.calls[0][0]).toBe(today)
    fireEvent.click(screen.getByText('Tacos'))
    expect(screen.getByTestId('where').textContent).toBe('/meals/mealie/tacos')
  })

  it('shows a compact error', async () => {
    mealplan.mockRejectedValue(unavailable)
    wrap(<WeekDinnersCard />)
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
  })
})

describe('MealieGroceryCard', () => {
  it('shows the unchecked count and first 5 unchecked, and goes to /lists', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, display: `Item ${i}`, checked: false, label: null, position: i }))
    items.push({ id: 'c', display: 'Done thing', checked: true, label: null, position: 9 })
    shopping.mockResolvedValue({ listId: 'l', listName: 'Weekly', items })
    wrap(<GroceryCard />)
    expect(await screen.findByText('Item 0')).toBeTruthy()
    expect(screen.getByText('Item 4')).toBeTruthy()
    expect(screen.queryByText('Item 5')).toBeNull()
    expect(screen.queryByText('Done thing')).toBeNull()
    expect(screen.getByText(/8 to get/)).toBeTruthy()
    fireEvent.click(screen.getByText('Item 0'))
    expect(screen.getByTestId('where').textContent).toBe('/lists')
  })

  it('shows a compact error', async () => {
    shopping.mockRejectedValue(unavailable)
    wrap(<GroceryCard />)
    expect(await screen.findByText("Can't reach Mealie right now.")).toBeTruthy()
  })
})

describe('not connected', () => {
  it('renders the built-in cards and never calls Mealie', async () => {
    mealieState.connected = false
    wrap(<><WeekDinnersCard /><GroceryCard /></>)
    expect(await screen.findByText('No dinners planned yet.')).toBeTruthy()
    expect(screen.getByLabelText('Add grocery item')).toBeTruthy()
    expect(mealplan).not.toHaveBeenCalled()
    expect(shopping).not.toHaveBeenCalled()
  })
})
