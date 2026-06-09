import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { Meals } from './Meals'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// Render the topbar slot alongside the screen so we can assert the per-screen
// topbar (Explore recipes / Plan my week / week-nav / picker chrome).
function TopbarProbe() {
  const { right, full } = useTopbarSlots()
  return <div data-testid="topbar">{full ?? right}</div>
}

// Build a YYYY-MM-DD in this week (Sunday-based), matching the grid's window.
function thisSunday(): Date {
  const s = new Date()
  s.setHours(0, 0, 0, 0)
  s.setDate(s.getDate() - s.getDay())
  return s
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const sun = thisSunday()
const wed = new Date(sun)
wed.setDate(sun.getDate() + 3)

const ravioli = {
  id: 'r1',
  title: 'Ravioli & Sausage Bake',
  emoji: '🍝',
  description: null,
  category: 'dinner',
  tags: null,
  prepTimeMinutes: null,
  cookTimeMinutes: 35,
  servings: 5,
  imageUrl: null,
  sourceName: null,
  isFavorite: false,
  cookedCount: 0,
}
const tacos = { ...ravioli, id: 'r2', title: 'Chorizo Street Tacos', emoji: '🌮', cookTimeMinutes: 25 }
const pancakes = { ...ravioli, id: 'r3', title: 'German Pancakes', emoji: '🥞', category: 'breakfast', cookTimeMinutes: 20 }

function entry(date: Date, mealType: string, recipe: typeof ravioli, cook?: unknown) {
  return {
    id: `e-${ymd(date)}-${mealType}`,
    date: ymd(date),
    mealType,
    title: null,
    recipeId: recipe.id,
    cook: cook ?? null,
    recipe: {
      title: recipe.title,
      emoji: recipe.emoji,
      category: recipe.category,
      prepTimeMinutes: null,
      cookTimeMinutes: recipe.cookTimeMinutes,
      servings: recipe.servings,
      imageUrl: null,
    },
  }
}

function mockApi(opts: { entries?: unknown[]; recipes?: unknown[]; planned?: unknown[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/meals/plan') && init?.method === 'POST') {
      opts.planned?.push(JSON.parse(init.body!))
      return { ok: true, json: async () => ({ entry: {} }) }
    }
    if (u.includes('/api/meals/week')) {
      return { ok: true, json: async () => ({ start: '', entries: opts.entries ?? [] }) }
    }
    if (u.includes('/api/recipes')) {
      return { ok: true, json: async () => ({ recipes: opts.recipes ?? [] }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderMeals() {
  return render(
    <MemoryRouter initialEntries={['/meals']}>
      <TopbarSlotProvider>
        <TopbarProbe />
        <Meals />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('Meals weekly planner', () => {
  it('renders the day header, meal rows, planned cells and empty +', async () => {
    mockApi({
      entries: [
        entry(wed, 'dinner', ravioli, { personId: 'p1', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#E0548B' }),
        entry(sun, 'breakfast', pancakes),
      ],
      recipes: [ravioli, tacos, pancakes],
    })
    renderMeals()

    // planned titles surface from the joined recipe
    expect(await screen.findByText('Ravioli & Sausage Bake')).toBeInTheDocument()
    expect(screen.getByText('German Pancakes')).toBeInTheDocument()

    // all four meal rows present
    expect(screen.getByText('Breakfast')).toBeInTheDocument()
    expect(screen.getByText('Lunch')).toBeInTheDocument()
    expect(screen.getByText('Dinner')).toBeInTheDocument()
    expect(screen.getByText('Snack')).toBeInTheDocument()

    // cook avatar shown on the planned dinner
    expect(screen.getByText('🦊')).toBeInTheDocument()

    // empty slots render as add buttons (7 days × 4 meals − 2 planned = 26)
    expect(screen.getAllByRole('button', { name: /^Add /i })).toHaveLength(26)

    // topbar actions
    const topbar = screen.getByTestId('topbar')
    expect(within(topbar).getByText('Explore recipes')).toBeInTheDocument()
    expect(within(topbar).getByText('Plan my week')).toBeInTheDocument()
    expect(within(topbar).getByText('This week')).toBeInTheDocument()
  })

  it('filters to dinners only', async () => {
    mockApi({ entries: [entry(wed, 'dinner', ravioli)], recipes: [ravioli] })
    renderMeals()
    await screen.findByText('Ravioli & Sausage Bake')

    fireEvent.click(within(screen.getByTestId('topbar')).getByText('Dinners'))
    expect(screen.queryByText('Breakfast')).not.toBeInTheDocument()
    expect(screen.getByText('Dinner')).toBeInTheDocument()
  })

  it('opens the picker on + and plans the chosen recipe into that slot', async () => {
    const planned: unknown[] = []
    mockApi({ entries: [], recipes: [ravioli, tacos, pancakes], planned })
    renderMeals()

    // open the picker for a dinner slot
    const adds = await screen.findAllByRole('button', { name: /^Add dinner/i })
    fireEvent.click(adds[0])

    // picker chrome + dinner-filtered cards
    expect(await screen.findByText(/Add a dinner ·/)).toBeInTheDocument()
    expect(screen.getByText('Chorizo Street Tacos')).toBeInTheDocument()
    // breakfast-only recipe is filtered out of the dinner list
    expect(screen.queryByText('German Pancakes')).not.toBeInTheDocument()

    // cards now open a preview; the quick "Select" button plans it
    const card = screen.getByText('Ravioli & Sausage Bake').closest('.mp-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Select' }))
    await waitFor(() => expect(planned).toHaveLength(1))
    expect(planned[0]).toMatchObject({ mealType: 'dinner', recipeId: 'r1' })
  })

  it('navigates to the recipe detail when tapping a planned meal', async () => {
    mockApi({ entries: [entry(wed, 'dinner', ravioli)], recipes: [ravioli] })
    render(
      <MemoryRouter initialEntries={['/meals']}>
        <TopbarSlotProvider>
          <Routes>
            <Route path="/meals" element={<Meals />} />
            <Route path="/meals/recipe/:id" element={<div>RECIPE DETAIL PAGE</div>} />
          </Routes>
        </TopbarSlotProvider>
      </MemoryRouter>
    )
    fireEvent.click(await screen.findByText('Ravioli & Sausage Bake'))
    expect(await screen.findByText('RECIPE DETAIL PAGE')).toBeInTheDocument()
  })

  it('advances to next week via the nav arrow (refetches)', async () => {
    mockApi({ entries: [], recipes: [] })
    renderMeals()
    await screen.findByText('Dinner')
    const calls0 = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
      String(c[0]).includes('/api/meals/week')
    ).length

    fireEvent.click(within(screen.getByTestId('topbar')).getByRole('button', { name: /Next week/i }))
    await waitFor(() => {
      const calls1 = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) =>
        String(c[0]).includes('/api/meals/week')
      ).length
      expect(calls1).toBeGreaterThan(calls0)
    })
  })
})
