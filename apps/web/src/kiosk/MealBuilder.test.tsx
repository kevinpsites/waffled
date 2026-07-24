import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { MealBuilder } from './MealBuilder'
import type { Meal, MealDish } from '../lib/api'

// ── fixtures ────────────────────────────────────────────────────────────────
function dish(over: Partial<MealDish> & { recipeId: string; title: string }): MealDish {
  return {
    emoji: '🍽️',
    category: 'dinner',
    role: 'side',
    sortOrder: 0,
    prepTimeMinutes: null,
    cookTimeMinutes: 20,
    servings: 4,
    imageUrl: null,
    cook: null,
    onHand: { have: 3, total: 5 },
    toBuy: 2,
    ...over,
  }
}

function plate(over: Partial<Meal> = {}): Meal {
  const recipes = over.recipes ?? []
  return {
    id: 'm1',
    name: 'BBQ Sunday',
    servings: 6,
    isSaved: false,
    createdBy: null,
    createdAt: '2026-07-23T00:00:00.000Z',
    recipeCount: recipes.length,
    emojis: recipes.map((r) => r.emoji ?? '🍽️'),
    totalMinutes: 65,
    onHand: { have: 4, total: 9 },
    toBuy: 5,
    ...over,
    recipes,
  }
}

function recipe(over: Record<string, unknown> & { id: string; title: string }) {
  return {
    emoji: '🥗',
    description: null,
    category: 'dinner',
    tags: null,
    prepTimeMinutes: null,
    cookTimeMinutes: 20,
    servings: 4,
    imageUrl: null,
    storageKey: null,
    sourceName: null,
    isFavorite: false,
    cookedCount: 0,
    lastCookedAt: null,
    mealType: null,
    protein: null,
    base: null,
    cuisine: null,
    effort: null,
    cookMethod: null,
    flavorProfile: null,
    dietary: [],
    vegetables: [],
    collection: null,
    ...over,
  }
}

// ── a tiny in-memory fake of the meals API ──────────────────────────────────
type Call = { method: string; url: string; body?: Record<string, unknown> }

let server: {
  plate: Meal | null
  saved: Meal[]
  recipes: Array<ReturnType<typeof recipe>>
  persons: Array<{ id: string; name: string; avatarEmoji: string | null; colorHex: string | null }>
  calls: Call[]
  added: number
}

function reset(init: Partial<typeof server> = {}) {
  server = { plate: null, saved: [], recipes: [], persons: [], calls: [], added: 0, ...init }
}

function recalc(m: Meal): Meal {
  return {
    ...m,
    recipeCount: m.recipes.length,
    emojis: m.recipes.map((r) => r.emoji ?? '🍽️'),
    toBuy: m.recipes.reduce((n, r) => n + r.toBuy, 0),
  }
}

function mockServer() {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    server.calls.push({ method, url: u, body })
    const ok = (v: unknown) => ({ ok: true, json: async () => v })

    if (u.startsWith('/api/recipes')) return ok({ recipes: server.recipes })
    if (u.startsWith('/api/persons')) return ok({ persons: server.persons })

    // GET /api/meals  (saved-meal library, optional ?q=)
    const listMatch = u.match(/^\/api\/meals(?:\?(.*))?$/)
    if (listMatch && method === 'GET') {
      const q = (new URLSearchParams(listMatch[1] ?? '').get('q') ?? '').toLowerCase()
      return ok({ meals: server.saved.filter((s) => !q || s.name.toLowerCase().includes(q)) })
    }

    // POST /api/meals — lazy create
    if (u === '/api/meals' && method === 'POST') {
      server.plate = plate({ id: 'new-1', name: body.name, servings: body.servings ?? 4, recipes: [] })
      return ok({ meal: server.plate })
    }

    // POST /api/meals/:id/recipes — add a dish OR flatten a saved meal
    if (/^\/api\/meals\/[^/]+\/recipes$/.test(u) && method === 'POST') {
      const m = server.plate!
      if (body.mealId) {
        const src = server.saved.find((s) => s.id === body.mealId)!
        server.plate = recalc({ ...m, recipes: [...m.recipes, ...src.recipes.map((r) => ({ ...r }))] })
      } else {
        const r = server.recipes.find((x) => x.id === body.recipeId)!
        server.plate = recalc({
          ...m,
          recipes: [
            ...m.recipes,
            dish({
              recipeId: r.id,
              title: r.title,
              emoji: r.emoji as string,
              role: body.role ?? 'side',
              cookTimeMinutes: r.cookTimeMinutes as number,
            }),
          ],
        })
      }
      return ok({ meal: server.plate })
    }

    // PATCH /api/meals/:id/recipes/:recipeId — per-dish cook assignment
    const patchDish = u.match(/^\/api\/meals\/[^/]+\/recipes\/([^/]+)$/)
    if (patchDish && method === 'PATCH') {
      const p = server.persons.find((x) => x.id === body.cookPersonId) ?? null
      server.plate = recalc({
        ...server.plate!,
        recipes: server.plate!.recipes.map((r) =>
          r.recipeId === patchDish[1]
            ? { ...r, cook: p ? { personId: p.id, name: p.name, avatarEmoji: p.avatarEmoji, colorHex: p.colorHex } : null }
            : r,
        ),
      })
      return ok({ meal: server.plate })
    }

    // DELETE /api/meals/:id/recipes/:recipeId
    const del = u.match(/^\/api\/meals\/[^/]+\/recipes\/([^/]+)$/)
    if (del && method === 'DELETE') {
      server.plate = recalc({ ...server.plate!, recipes: server.plate!.recipes.filter((r) => r.recipeId !== del[1]) })
      return ok({ meal: server.plate })
    }

    if (/^\/api\/meals\/[^/]+\/schedule$/.test(u) && method === 'POST') {
      return ok({ entry: { id: 'e1', date: body.date, mealType: body.mealType, mealId: server.plate!.id }, meal: server.plate })
    }

    if (/^\/api\/meals\/[^/]+\/add-to-list/.test(u) && method === 'POST') {
      return ok({ added: server.added, weekStart: '2026-07-19' })
    }

    // PATCH /api/meals/:id — rename / servings / save-to-reuse
    if (/^\/api\/meals\/[^/]+$/.test(u) && method === 'PATCH') {
      server.plate = { ...server.plate!, ...body }
      return ok({ meal: server.plate })
    }

    // GET /api/meals/:id
    if (/^\/api\/meals\/[^/]+$/.test(u) && method === 'GET') {
      if (!server.plate) return { ok: false, status: 404, json: async () => ({}) }
      return ok({ meal: server.plate })
    }

    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderBuilder(path = '/meals/build/m1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/meals" element={<div>MEALS PAGE</div>} />
        <Route path="/meals/build" element={<MealBuilder />} />
        <Route path="/meals/build/:id" element={<MealBuilder />} />
        <Route path="/meals/recipe/:id" element={<div>RECIPE DETAIL PAGE</div>} />
        <Route path="/lists" element={<div>LISTS PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function group(label: string): HTMLElement {
  const heads = [...document.querySelectorAll('.mb-group-label')].filter((n) => n.textContent === label)
  return heads[0].closest('.mb-group') as HTMLElement
}

beforeEach(() => {
  reset()
  mockServer()
})

// ── plate rendering ─────────────────────────────────────────────────────────
describe('MealBuilder — the plate', () => {
  it('groups dishes by role in Main → Sides → Dessert order', async () => {
    server.plate = plate({
      recipes: [
        dish({ recipeId: 'r3', title: 'Peach Cobbler', role: 'dessert', emoji: '🍑' }),
        dish({ recipeId: 'r2', title: 'Coleslaw', role: 'side', emoji: '🥗' }),
        dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main', emoji: '🍗' }),
        dish({ recipeId: 'r4', title: 'Potato Salad', role: 'side', emoji: '🥔' }),
      ],
    })
    renderBuilder()

    await screen.findByText('BBQ Chicken')
    const labels = [...document.querySelectorAll('.mb-group-label')].map((n) => n.textContent)
    expect(labels).toEqual(['Main', 'Sides', 'Dessert'])

    // each dish lands in its own role group
    expect(within(group('Main')).getByText('BBQ Chicken')).toBeInTheDocument()
    expect(within(group('Sides')).getByText('Coleslaw')).toBeInTheDocument()
    expect(within(group('Sides')).getByText('Potato Salad')).toBeInTheDocument()
    expect(within(group('Dessert')).getByText('Peach Cobbler')).toBeInTheDocument()

    // a count badge only on non-empty groups
    expect(within(group('Sides')).getByText('2')).toBeInTheDocument()
    expect(within(group('Main')).getByText('1')).toBeInTheDocument()
  })

  it('renders an empty drop zone per role with role-specific wording', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()
    expect(await screen.findByRole('button', { name: 'Add a main' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a side' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a dessert' })).toBeInTheDocument()
  })

  it('does NOT render the deferred AI "pairs well here" suggestion in an empty slot', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()
    await screen.findByRole('button', { name: 'Add a main' })
    expect(screen.queryByText(/pairs well/i)).not.toBeInTheDocument()
  })

  it('navigates to the recipe detail when the dish title is tapped', async () => {
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' })] })
    renderBuilder()
    fireEvent.click(await screen.findByText('BBQ Chicken'))
    expect(await screen.findByText('RECIPE DETAIL PAGE')).toBeInTheDocument()
  })

  it('removes a dish from the plate', async () => {
    server.plate = plate({
      recipes: [
        dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' }),
        dish({ recipeId: 'r2', title: 'Coleslaw', role: 'side' }),
      ],
    })
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Coleslaw' }))
    await waitFor(() => expect(screen.queryByText('Coleslaw')).not.toBeInTheDocument())
    expect(screen.getByText('BBQ Chicken')).toBeInTheDocument()
    expect(server.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/recipes/r2'))).toBe(true)
  })
})

// ── the on-hand rendering rule (decision 14) ────────────────────────────────
describe('MealBuilder — on-hand rendering rule', () => {
  it('renders "✓ all on hand" when nothing is left to buy', async () => {
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'Coleslaw', onHand: { have: 4, total: 4 }, toBuy: 0 })] })
    renderBuilder()
    const row = (await screen.findByText('Coleslaw')).closest('.mb-dish') as HTMLElement
    expect(within(row).getByText('✓ all on hand')).toBeInTheDocument()
    expect(within(row).queryByText(/to buy/)).not.toBeInTheDocument()
  })

  it('renders "N to buy" when some ingredients are missing — never "0 of N"', async () => {
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'Coleslaw', onHand: { have: 0, total: 4 }, toBuy: 4 })] })
    renderBuilder()
    const row = (await screen.findByText('Coleslaw')).closest('.mb-dish') as HTMLElement
    expect(within(row).getByText('4 to buy')).toBeInTheDocument()
    expect(within(row).queryByText(/of 4/)).not.toBeInTheDocument()
    expect(within(row).queryByText(/on hand/)).not.toBeInTheDocument()
  })

  it('makes NO on-hand claim at all when the pantry module is off (onHand === null)', async () => {
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'Coleslaw', onHand: null, toBuy: 4, cookTimeMinutes: 20 })] })
    renderBuilder()
    const row = (await screen.findByText('Coleslaw')).closest('.mb-dish') as HTMLElement
    // the time still shows…
    expect(within(row).getByText('🕐 20 min')).toBeInTheDocument()
    // …but nothing that claims anything about the pantry
    expect(within(row).queryByText(/on hand/)).not.toBeInTheDocument()
    expect(within(row).queryByText(/to buy/)).not.toBeInTheDocument()
    expect(within(row).queryByText(/0 of/)).not.toBeInTheDocument()
  })
})

// ── the library panel ───────────────────────────────────────────────────────
describe('MealBuilder — add from library', () => {
  beforeEach(() => {
    server.recipes = [
      recipe({ id: 'r1', title: 'BBQ Chicken', emoji: '🍗', category: 'dinner', cookTimeMinutes: 40 }),
      recipe({ id: 'r2', title: 'Coleslaw', emoji: '🥗', category: 'dinner', cookTimeMinutes: 15 }),
      recipe({ id: 'r3', title: 'Peach Cobbler', emoji: '🍑', category: 'dessert', cookTimeMinutes: 55 }),
    ]
  })

  it('adds a recipe to the plate with the role of the slot that was clicked', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()

    fireEvent.click(await screen.findByRole('button', { name: 'Add a main' }))
    // the "adding to…" banner appears and the filter follows the role
    expect(await screen.findByText(/Adding to Main/)).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Add BBQ Chicken' }))
    await waitFor(() => expect(within(group('Main')).getByText('BBQ Chicken')).toBeInTheDocument())
    const post = server.calls.find((c) => c.method === 'POST' && c.url.endsWith('/recipes'))
    expect(post?.body).toMatchObject({ recipeId: 'r1', role: 'main' })
  })

  it('dims a recipe that is already on the plate and disables its add button', async () => {
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' })] })
    renderBuilder()
    await screen.findByRole('button', { name: 'Add Coleslaw' })
    const row = document.querySelector('.mb-lib-row.is-on') as HTMLElement
    expect(within(row).getByText('BBQ Chicken')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /Add BBQ Chicken/ })).toBeDisabled()
  })

  it('filters the library by the segment chooser', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()
    await screen.findByText('Peach Cobbler')

    const seg = document.querySelector('.mb-lib-seg') as HTMLElement
    fireEvent.click(within(seg).getByRole('button', { name: 'Desserts' }))
    const lib = document.querySelector('.mb-lib-rows') as HTMLElement
    expect(within(lib).getByText('Peach Cobbler')).toBeInTheDocument()
    expect(within(lib).queryByText('BBQ Chicken')).not.toBeInTheDocument()
  })

  it('searches recipes AND saved meals (debounced)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      server.plate = plate({ recipes: [] })
      server.saved = [plate({ id: 'sm1', name: 'Cobbler Night', isSaved: true, recipes: [dish({ recipeId: 'r3', title: 'Peach Cobbler', role: 'dessert' })] })]
      renderBuilder()
      await screen.findByText('BBQ Chicken')

      fireEvent.change(screen.getByLabelText('Search recipes and meals'), { target: { value: 'cobbler' } })
      await vi.advanceTimersByTimeAsync(400)

      const lib = document.querySelector('.mb-lib-rows') as HTMLElement
      await waitFor(() => expect(within(lib).getByText('Cobbler Night')).toBeInTheDocument())
      expect(within(lib).getByText('Peach Cobbler')).toBeInTheDocument()
      expect(within(lib).queryByText('BBQ Chicken')).not.toBeInTheDocument()
      // the saved-meal query went to the server
      expect(server.calls.some((c) => c.method === 'GET' && c.url.includes('/api/meals?q=cobbler'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('badges a saved meal and FLATTENS it into individual dishes when added', async () => {
    server.plate = plate({ recipes: [] })
    server.saved = [
      plate({
        id: 'sm1',
        name: 'Sunday Feast',
        isSaved: true,
        recipes: [
          dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main', emoji: '🍗' }),
          dish({ recipeId: 'r2', title: 'Coleslaw', role: 'side', emoji: '🥗' }),
        ],
      }),
    ]
    renderBuilder()

    const savedRow = (await screen.findByText('Sunday Feast')).closest('.mb-lib-row') as HTMLElement
    expect(within(savedRow).getByText('Meal · 2')).toBeInTheDocument()

    fireEvent.click(within(savedRow).getByRole('button', { name: 'Add Sunday Feast' }))

    await waitFor(() => expect(within(group('Main')).getByText('BBQ Chicken')).toBeInTheDocument())
    expect(within(group('Sides')).getByText('Coleslaw')).toBeInTheDocument()
    // flattened via the mealId form of the add-dish endpoint — meals never nest
    const post = server.calls.find((c) => c.method === 'POST' && c.url.endsWith('/recipes'))
    expect(post?.body).toEqual({ mealId: 'sm1' })
  })
})

// ── the footer stat bar ─────────────────────────────────────────────────────
describe('MealBuilder — footer stat bar', () => {
  it('steps servings up and down and never goes below 1', async () => {
    server.plate = plate({ servings: 2, recipes: [] })
    renderBuilder()
    await screen.findByRole('button', { name: 'More servings' })

    fireEvent.click(screen.getByRole('button', { name: 'More servings' }))
    await waitFor(() => expect(screen.getByTestId('mb-serves')).toHaveTextContent('3'))

    fireEvent.click(screen.getByRole('button', { name: 'Fewer servings' }))
    await waitFor(() => expect(screen.getByTestId('mb-serves')).toHaveTextContent('2'))
    fireEvent.click(screen.getByRole('button', { name: 'Fewer servings' }))
    await waitFor(() => expect(screen.getByTestId('mb-serves')).toHaveTextContent('1'))

    fireEvent.click(screen.getByRole('button', { name: 'Fewer servings' }))
    await waitFor(() => expect(screen.getByTestId('mb-serves')).toHaveTextContent('1'))
    const patches = server.calls.filter((c) => c.method === 'PATCH')
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.every((p) => (p.body as { servings: number }).servings >= 1)).toBe(true)
  })

  it('shows hands-on time and the groceries count', async () => {
    server.plate = plate({ totalMinutes: 65, toBuy: 7, recipes: [dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' })] })
    renderBuilder()
    expect(await screen.findByText('≈ 1h 5m')).toBeInTheDocument()
    expect(screen.getByText('7 to buy')).toBeInTheDocument()
  })

  it('toggles "Save to reuse"', async () => {
    server.plate = plate({ name: 'BBQ Sunday', isSaved: false, recipes: [] })
    renderBuilder()
    const toggle = await screen.findByRole('switch', { name: /Save .*BBQ Sunday.* to reuse/ })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    expect(server.calls.some((c) => c.method === 'PATCH' && (c.body as { isSaved?: boolean }).isSaved === true)).toBe(true)
  })

  it('disables "Schedule meal" while the plate is empty', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()
    expect(await screen.findByRole('button', { name: 'Schedule meal' })).toBeDisabled()
  })

  it('adds the whole plate to the grocery list', async () => {
    server.added = 6
    server.plate = plate({ recipes: [dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' })] })
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: 'Add plate to list' }))
    await waitFor(() => expect(screen.getByText(/Added 6 items/)).toBeInTheDocument())
    expect(server.calls.some((c) => c.method === 'POST' && c.url.includes('/add-to-list'))).toBe(true)
  })
})

// ── the schedule modal ──────────────────────────────────────────────────────
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('MealBuilder — schedule modal', () => {
  beforeEach(() => {
    server.plate = plate({ name: 'BBQ Sunday', servings: 6, toBuy: 6, recipes: [dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main', emoji: '🍗' })] })
  })

  async function openModal() {
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule meal' }))
    return (await screen.findByRole('button', { name: 'Confirm' })).closest('.modal-card') as HTMLElement
  }

  it('offers all three meal slots (not just dinner)', async () => {
    const card = await openModal()
    expect(within(card).getByRole('button', { name: 'Breakfast' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Lunch' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Dinner' })).toBeInTheDocument()
    // 'Snack' is not a Meal Builder slot
    expect(within(card).queryByRole('button', { name: 'Snack' })).not.toBeInTheDocument()
  })

  it('summarises the plate', async () => {
    const card = await openModal()
    expect(within(card).getByText('BBQ Sunday')).toBeInTheDocument()
    expect(within(card).getByText('Meal · 1 recipe · Serves 6')).toBeInTheDocument()
  })

  it('navigates weeks forward and back so meals can be planned in advance', async () => {
    const card = await openModal()
    expect(within(card).getByText('This week')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Next week' }))
    expect(within(card).getByText('Next week')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Next week' }))
    expect(within(card).queryByText('Next week')).not.toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Previous week' }))
    expect(within(card).getByText('Next week')).toBeInTheDocument()
  })

  it('keeps Confirm disabled until a day is picked, then schedules and toasts', async () => {
    const card = await openModal()
    const confirm = within(card).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()

    fireEvent.click(within(card).getByRole('button', { name: 'Lunch' }))
    const sunday = new Date()
    sunday.setHours(0, 0, 0, 0)
    sunday.setDate(sunday.getDate() - sunday.getDay())
    fireEvent.click(within(card).getByTestId(`mb-day-${ymd(sunday)}`))
    expect(confirm).not.toBeDisabled()

    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument())

    const post = server.calls.find((c) => c.url.includes('/schedule'))
    expect(post?.body).toMatchObject({ date: ymd(sunday), mealType: 'lunch' })

    // toast + a link straight to the grocery list
    expect(await screen.findByText(/Added “BBQ Sunday” to Sunday lunch · built 6-item list/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'View grocery' }))
    expect(await screen.findByText('LISTS PAGE')).toBeInTheDocument()
  })
})

// ── lazy creation of a brand-new plate ──────────────────────────────────────
describe('MealBuilder — a brand-new plate', () => {
  it('creates the meal lazily on the first dish add and moves to /meals/build/:id', async () => {
    server.recipes = [recipe({ id: 'r1', title: 'BBQ Chicken', emoji: '🍗' })]
    renderBuilder('/meals/build')

    // nothing created just by landing on the screen
    await screen.findByRole('button', { name: 'Add a main' })
    expect(server.calls.some((c) => c.method === 'POST' && c.url === '/api/meals')).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: 'Add BBQ Chicken' }))
    await waitFor(() => expect(server.calls.some((c) => c.method === 'POST' && c.url === '/api/meals')).toBe(true))
    await waitFor(() => expect(within(group('Sides')).getByText('BBQ Chicken')).toBeInTheDocument())
  })

  it('creates the meal lazily on the first rename', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderBuilder('/meals/build')
      const name = await screen.findByLabelText('Meal name')
      fireEvent.change(name, { target: { value: 'Taco Tuesday' } })
      await vi.advanceTimersByTimeAsync(900)
      await waitFor(() => {
        const post = server.calls.find((c) => c.method === 'POST' && c.url === '/api/meals')
        expect(post?.body).toMatchObject({ name: 'Taco Tuesday' })
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('renames an existing plate through the inline title input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      server.plate = plate({ name: 'BBQ Sunday', recipes: [] })
      renderBuilder()
      const name = await screen.findByLabelText('Meal name')
      expect(name).toHaveValue('BBQ Sunday')
      fireEvent.change(name, { target: { value: 'Smoky Sunday' } })
      await vi.advanceTimersByTimeAsync(900)
      await waitFor(() => {
        const patch = server.calls.find((c) => c.method === 'PATCH' && (c.body as { name?: string }).name)
        expect(patch?.body).toMatchObject({ name: 'Smoky Sunday' })
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes back to Meals from the header pill', async () => {
    server.plate = plate({ recipes: [] })
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: '‹ Meals' }))
    expect(await screen.findByText('MEALS PAGE')).toBeInTheDocument()
  })
})

// ── per-dish cook assignment (decision 10) ──────────────────────────────────
describe('MealBuilder — who cooks each dish', () => {
  beforeEach(() => {
    server.persons = [
      { id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED' },
      { id: 'p2', name: 'Sarah', avatarEmoji: '🦊', colorHex: '#E0548B' },
    ]
    server.plate = plate({
      recipes: [
        dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main' }),
        dish({ recipeId: 'r2', title: 'Potato Salad', role: 'side' }),
      ],
    })
  })

  it('defaults every dish to "whoever" — no cook badge', async () => {
    renderBuilder()
    const picker = await screen.findByLabelText('Who cooks BBQ Chicken?')
    expect(picker).toHaveValue('')
    expect(screen.queryByText(/👩‍🍳/)).not.toBeInTheDocument()
  })

  it('assigns a cook to one dish without touching the others', async () => {
    renderBuilder()
    const picker = await screen.findByLabelText('Who cooks BBQ Chicken?')
    fireEvent.change(picker, { target: { value: 'p2' } })

    await waitFor(() => {
      const patch = server.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/recipes/r1'))
      expect(patch?.body).toEqual({ cookPersonId: 'p2' })
    })

    const chicken = (await screen.findByText('BBQ Chicken')).closest('.mb-dish') as HTMLElement
    await waitFor(() => expect(within(chicken).getByText(/Sarah/, { selector: '.mb-cook-badge' })).toBeInTheDocument())

    // the other dish is untouched
    const salad = screen.getByText('Potato Salad').closest('.mb-dish') as HTMLElement
    expect(within(salad).queryByText(/Sarah/, { selector: '.mb-cook-badge' })).not.toBeInTheDocument()
    expect(within(salad).getByLabelText('Who cooks Potato Salad?')).toHaveValue('')
  })

  it('clears an assignment back to "whoever"', async () => {
    server.plate = plate({
      recipes: [
        dish({ recipeId: 'r1', title: 'BBQ Chicken', role: 'main', cook: { personId: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED' } }),
      ],
    })
    renderBuilder()
    const picker = await screen.findByLabelText('Who cooks BBQ Chicken?')
    await waitFor(() => expect(picker).toHaveValue('p1'))

    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() => {
      const patch = server.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/recipes/r1'))
      expect(patch?.body).toEqual({ cookPersonId: null })
    })
    await waitFor(() => expect(screen.queryByText(/Kevin/, { selector: '.mb-cook-badge' })).not.toBeInTheDocument())
  })
})
