import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { CookMode } from './CookMode'
import { TopbarSlotProvider } from './topbar-slot'

// Timers across a whole plate. A plate is several dishes cooked side by side, so a
// timer belongs to a DISH, not just to "step 3" — it has to keep running while you
// work on another dish, say which dish it's for in the dock and in the alarm, and
// take you back to the right dish AND step when you tap it.
//
// The single-recipe route must be untouched by all of that — its dock and alarm look
// exactly as they always have (no dish line), which the last describe block pins.

interface DishSpec {
  recipeId: string
  title: string
  emoji: string
  steps: string[]
}

function plateJson(name: string, dishes: DishSpec[]) {
  return {
    meal: {
      id: 'm1',
      name,
      servings: 4,
      isSaved: false,
      createdBy: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      recipeCount: dishes.length,
      emojis: dishes.map((d) => d.emoji),
      totalMinutes: null,
      onHand: null,
      toBuy: 0,
      recipes: dishes.map((d, k) => ({
        recipeId: d.recipeId,
        title: d.title,
        emoji: d.emoji,
        category: null,
        role: k === 0 ? 'main' : 'side',
        sortOrder: k,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        servings: null,
        imageUrl: null,
        cook: null,
        onHand: null,
        toBuy: 0,
      })),
    },
  }
}

function mockPlate(name: string, dishes: DishSpec[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/api/meals/m1')) return { ok: true, json: async () => plateJson(name, dishes) }
    const dish = dishes.find((d) => u.endsWith(`/api/recipes/${d.recipeId}`))
    if (dish) {
      return {
        ok: true,
        json: async () => ({
          recipe: { id: dish.recipeId, title: dish.title, emoji: dish.emoji },
          ingredients: [],
          steps: dish.steps.map((instruction, k) => ({
            stepNumber: k + 1,
            instruction,
            ingredients: [],
            note: null,
            timerSeconds: null,
          })),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function mockSingleRecipe(steps: string[]) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/api/recipes/r1')) {
      return {
        ok: true,
        json: async () => ({
          recipe: { id: 'r1', title: 'Test Recipe' },
          ingredients: [],
          steps: steps.map((instruction, k) => ({
            stepNumber: k + 1,
            instruction,
            ingredients: [],
            note: null,
            timerSeconds: null,
          })),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipe/:id/cook" element={<CookMode />} />
          <Route path="/meals/meal/:id/cook" element={<CookMode />} />
          <Route path="/meals/recipe/:id" element={<div>recipe page</div>} />
          <Route path="/meals/build/:id" element={<div>plate page</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

const BBQ: DishSpec = {
  recipeId: 'r1',
  title: 'BBQ Chicken',
  emoji: '🍗',
  steps: ['Rub the chicken', 'Grill it', 'Rest it', 'Slice and serve'],
}
const SALAD: DishSpec = {
  recipeId: 'r2',
  title: 'Potato Salad',
  emoji: '🥔',
  steps: ['Boil the potatoes', 'Mix the dressing'],
}

// Start an on-the-spot timer on whatever step is showing.
function startTimer(minutes: number, seconds = 0) {
  fireEvent.click(screen.getByRole('button', { name: /add timer/i }))
  fireEvent.change(screen.getByLabelText(/minutes/i), { target: { value: String(minutes) } })
  if (seconds) fireEvent.change(screen.getByLabelText(/seconds/i), { target: { value: String(seconds) } })
  fireEvent.click(screen.getByRole('button', { name: /start timer/i }))
}

const dock = () => screen.getByRole('status')
const alarm = () => screen.getByRole('alertdialog')
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
const tabs = () => screen.getAllByRole('tab')

afterEach(() => {
  vi.useRealTimers()
})

describe('CookMode — timers survive switching dishes', () => {
  it('keeps a dish’s timer running while you cook another dish', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    startTimer(2)
    tick(3000)
    expect(dock().textContent).toContain('1:57')

    // Off to the potato salad — the chicken's timer must still be docked and ticking.
    fireEvent.click(tabs()[1])
    expect(screen.getByText('Boil the potatoes')).toBeTruthy()
    expect(dock().textContent).toContain('1:57')
    tick(5000)
    expect(dock().textContent).toContain('1:52')

    // …and back to the chicken, right where we left it, still the same one timer.
    fireEvent.click(tabs()[0])
    expect(screen.getByText('Rub the chicken')).toBeTruthy()
    tick(2000)
    expect(dock().textContent).toContain('1:50')
    expect(screen.getAllByRole('button', { name: /dismiss timer/i })).toHaveLength(1)
  })

  it('shows every dish’s running timers in one dock, each labelled with its dish', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    startTimer(2)
    fireEvent.click(tabs()[1])
    startTimer(1)

    const d = dock()
    expect(d.textContent).toContain('BBQ Chicken')
    expect(d.textContent).toContain('Potato Salad')
    expect(d.textContent).toContain('2:00')
    expect(d.textContent).toContain('1:00')
    expect(within(d).getAllByText('Step 1')).toHaveLength(2)
  })

  it('names the dish in the alarm when a timer fires', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    // Chicken, step 2.
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Grill it')).toBeTruthy()
    startTimer(1)

    // Wander off to the salad; the chicken's timer fires while we're there.
    fireEvent.click(tabs()[1])
    tick(60_000)

    const a = alarm()
    expect(a.textContent).toContain('BBQ Chicken')
    expect(a.textContent).toContain('Step 2')
  })
})

describe('CookMode — a docked timer takes you back to its dish', () => {
  it('jumps to the right dish AND the right step', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Rest it')).toBeTruthy() // chicken step 3
    startTimer(3)

    // Move to the salad and walk it forward, so the jump has to undo two things.
    fireEvent.click(tabs()[1])
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Mix the dressing')).toBeTruthy()

    fireEvent.click(within(dock()).getByRole('button', { name: /jump to this step/i }))

    expect(screen.getByText('Rest it')).toBeTruthy()
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    // Still running — jumping from the dock never cancels the timer.
    expect(dock().textContent).toContain('3:00')
    tick(1000)
    expect(dock().textContent).toContain('2:59')
  })

  it('jumps to the right dish AND step from the alarm, and clears the alarm', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Grill it')).toBeTruthy()
    startTimer(1)

    fireEvent.click(tabs()[1])
    tick(60_000)
    fireEvent.click(within(alarm()).getByRole('button', { name: /jump to step/i }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('Grill it')).toBeTruthy()
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('CookMode — plate timer controls still work', () => {
  it('pauses and resumes a timer from another dish’s tab', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    startTimer(2)
    fireEvent.click(tabs()[1])
    tick(2000)
    expect(dock().textContent).toContain('1:58')

    fireEvent.click(screen.getByRole('button', { name: /pause timer/i }))
    tick(5000)
    expect(dock().textContent).toContain('1:58')

    fireEvent.click(screen.getByRole('button', { name: /resume timer/i }))
    tick(3000)
    expect(dock().textContent).toContain('1:55')
  })

  it('dismisses a timer from the dock', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    startTimer(2)
    fireEvent.click(tabs()[1])
    fireEvent.click(screen.getByRole('button', { name: /dismiss timer/i }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('snoozes a fired timer for another minute, keeping its dish', async () => {
    mockPlate('BBQ Sunday', [BBQ, SALAD])
    renderAt('/meals/meal/m1/cook')
    await screen.findByText('Rub the chicken')

    vi.useFakeTimers()
    startTimer(0, 30)
    fireEvent.click(tabs()[1])
    tick(30_000)
    expect(alarm().textContent).toContain('BBQ Chicken')

    fireEvent.click(within(alarm()).getByRole('button', { name: /\+1:00/ }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(dock().textContent).toContain('1:00')
    expect(dock().textContent).toContain('BBQ Chicken')
    tick(1000)
    expect(dock().textContent).toContain('0:59')
  })
})

describe('CookMode — single-recipe timers are unchanged', () => {
  it('docks a timer with just its step — no dish line', async () => {
    mockSingleRecipe(['Chop the onions', 'Heat the pan'])
    renderAt('/meals/recipe/r1/cook')
    await screen.findByText('Chop the onions')

    vi.useFakeTimers()
    startTimer(5, 30)

    const d = dock()
    expect(d.textContent).toContain('Step 1')
    expect(d.textContent).toContain('5:30')
    // The recipe title belongs in the topbar, never in the single-recipe dock.
    expect(within(d).queryByText(/Test Recipe/)).toBeNull()
    expect(d.textContent).not.toContain('Test Recipe')

    tick(2000)
    expect(dock().textContent).toContain('5:28')
    expect(screen.getByRole('button', { name: /pause timer/i })).toBeTruthy()
  })

  it('fires an alarm naming just the step, and jumps back to it', async () => {
    mockSingleRecipe(['Chop the onions', 'Heat the pan'])
    renderAt('/meals/recipe/r1/cook')
    await screen.findByText('Chop the onions')

    vi.useFakeTimers()
    startTimer(0, 30)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByText('Heat the pan')).toBeTruthy()

    tick(30_000)
    const a = alarm()
    expect(a.textContent).toContain('Timer done')
    expect(a.textContent).toContain('Step 1')
    expect(a.textContent).not.toContain('Test Recipe')

    fireEvent.click(within(a).getByRole('button', { name: /jump to step/i }))
    expect(screen.getByText('Chop the onions')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still has no tab strip when a timer is running', async () => {
    mockSingleRecipe(['Chop the onions'])
    renderAt('/meals/recipe/r1/cook')
    await screen.findByText('Chop the onions')

    vi.useFakeTimers()
    startTimer(1)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})
