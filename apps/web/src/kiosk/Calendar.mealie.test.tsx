import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'
import { Calendar } from './Calendar'
import { TopbarSlotProvider } from './topbar-slot'

const mealieState = { connected: true, hasShoppingList: false, loading: false, refresh: () => {} }
const mealplan = vi.fn()
vi.mock('../lib/mealie-context', () => ({ useMealie: () => mealieState }))
vi.mock('../lib/api/mealie', async (orig) => ({
  ...(await orig<typeof import('../lib/api/mealie')>()),
  mealieApi: { mealplan: (...a: unknown[]) => mealplan(...a) },
}))

const EVENTS = [
  { id: 'e1', title: 'Dentist', startsAt: '', endsAt: null, allDay: false, location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [] },
  { id: 'e2', title: 'Mirror dinner', startsAt: '', endsAt: null, allDay: false, location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [], origin: 'meal_plan' },
]

function mockApi() {
  const at = new Date(2026, 5, 15, 12).toISOString()
  globalThis.fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('/api/events?') ? { from: '', to: '', events: EVENTS.map((e) => ({ ...e, startsAt: at })) } : {}),
  })) as unknown as typeof fetch
}

function Where() { return <div data-testid="loc">{useLocation().pathname}</div> }
function renderCal() {
  return render(
    <MemoryRouter initialEntries={['/calendar?date=2026-06-15&view=month']}>
      <TopbarSlotProvider>
        <Routes><Route path="*" element={<><Where /><Calendar /></>} /></Routes>
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('Calendar with Mealie', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 5, 15, 9))
    mealieState.connected = true
    mealplan.mockReset()
    mockApi()
  })
  afterEach(() => vi.useRealTimers())

  it('overlays Mealie chips, hides meal mirrors, and opens the cook view', async () => {
    mealplan.mockResolvedValue({ entries: [{ id: 3, date: '2026-06-15', entryType: 'dinner', title: 'Tacos', recipe: { id: 'r', slug: 'tacos', name: 'Tacos', imageUrl: null } }] })
    renderCal()
    const chip = (await screen.findAllByText('🍽️ Tacos'))[0]
    expect(mealplan).toHaveBeenCalledTimes(1)
    const [from, to] = mealplan.mock.calls[0] as string[]
    expect(from <= '2026-06-01' && to >= '2026-06-30').toBe(true)
    expect(screen.getAllByText('Dentist').length).toBeGreaterThan(0)
    expect(screen.queryByText('Mirror dinner')).toBeNull()
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/meals/mealie/tacos'))
  })

  it('still renders events when Mealie fails', async () => {
    mealplan.mockRejectedValue(new Error('down'))
    renderCal()
    expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0)
    await waitFor(() => expect(mealplan).toHaveBeenCalled())
    expect(screen.queryByText(/🍽️/)).toBeNull()
  })

  it('leaves events alone and makes no Mealie request when not connected', async () => {
    mealieState.connected = false
    renderCal()
    expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Mirror dinner').length).toBeGreaterThan(0)
    expect(mealplan).not.toHaveBeenCalled()
  })
})
