import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Lists } from './Lists'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

const mealieState = { connected: true, hasShoppingList: true, loading: false, refresh: () => {} }
vi.mock('../lib/mealie-context', () => ({ useMealie: () => mealieState }))
vi.mock('./components/MealieShoppingList', () => ({ MealieShoppingList: ({ onBack }: { onBack: () => void }) => <div>mealie-shopping<button onClick={onBack}>‹ Lists</button></div> }))

const grocery = { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 15 }
const packing = { id: 'pack', name: 'Lake trip packing', emoji: '🧳', listType: 'custom', isAutoBuilt: false, sortMode: 'manual', itemCount: 3 }

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (u.endsWith('/api/lists/templates')) return { ok: true, json: async () => ({ templates: [] }) }
    if (u.includes('/api/lists/grocery/board')) return { ok: true, json: async () => ({ list: grocery, weekStart: '2026-06-07', meals: [], items: [], staples: [] }) }
    if (/\/api\/lists\/[^/]+$/.test(u)) return { ok: true, json: async () => ({ list: packing, items: [] }) }
    if (u.endsWith('/api/lists')) return { ok: true, json: async () => ({ lists: [grocery, packing] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}
function Slots() {
  const { right, full } = useTopbarSlots()
  return <div>{full}{right}</div>
}
const renderScreen = () => render(
  <MemoryRouter initialEntries={['/lists']}><TopbarSlotProvider><Slots /><Lists /></TopbarSlotProvider></MemoryRouter>
)

beforeEach(() => { mealieState.connected = true; mockApi() })

describe('Lists grocery swap', () => {
  it('renders the Mealie shopping list when connected, and custom lists still open', async () => {
    renderScreen()
    expect(await screen.findByText('mealie-shopping')).toBeTruthy()
    expect(screen.queryByLabelText('Add to groceries')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '‹ Lists' }))
    expect((await screen.findAllByText('Lake trip packing')).length).toBeGreaterThan(0)
    expect(screen.queryByText('mealie-shopping')).toBeNull()
  })

  it('renders the built-in GroceryBoard when not connected', async () => {
    mealieState.connected = false
    renderScreen()
    expect(await screen.findByLabelText('Add to groceries')).toBeTruthy()
    expect(screen.queryByText('mealie-shopping')).toBeNull()
  })
})
