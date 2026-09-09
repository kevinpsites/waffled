import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeBrowser } from './RecipeBrowser'
import { TopbarSlotProvider } from '../topbar-slot'
import type { Meal, Recipe } from '../../lib/api'

// The picker could write a new RECIPE but not a new PLATE, so filling a slot with a
// two-dish dinner meant abandoning the picker for the Meal Builder screen. It now
// builds the plate itself, with the builder's own body rather than a second, lesser
// plate editor.

interface Sent { method: string; url: string; body: unknown }
const sent: Sent[] = []

function makeRecipe(over: Partial<Recipe> & { id: string; title: string }): Recipe {
  return {
    emoji: null, description: null, category: null, tags: null,
    prepTimeMinutes: null, cookTimeMinutes: null, servings: 4,
    imageUrl: null, storageKey: null, sourceName: null,
    isFavorite: false, cookedCount: 0, lastCookedAt: null,
    mealType: null, protein: null, base: null, cuisine: null, effort: null,
    cookMethod: null, flavorProfile: null, dietary: [], vegetables: [], collection: null,
    ...over,
  }
}

const RECIPES = [makeRecipe({ id: 'r1', title: 'Chicken Parmesan' })]

const PLATE = (over: Partial<Meal> = {}): Meal =>
  ({
    id: 'm-new',
    name: 'Sunday Roast',
    notes: null,
    servings: 4,
    isSaved: true,
    createdBy: null,
    createdAt: '2026-09-01T00:00:00Z',
    recipeCount: 0,
    emojis: [],
    totalMinutes: null,
    toBuy: 0,
    recipes: [],
    ...over,
  }) as unknown as Meal

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.includes('/api/recipes') && method === 'GET') {
      return { ok: true, json: async () => ({ recipes: RECIPES }) }
    }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (/\/api\/meals\/[^/]+\/recipes$/.test(u) && method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          meal: PLATE({
            recipeCount: 1,
            recipes: [{ recipeId: 'r1', title: 'Chicken Parmesan', role: 'main' }] as never,
          }),
        }),
      }
    }
    if (u.includes('/api/meals') && method === 'POST') {
      return { ok: true, json: async () => ({ meal: PLATE({ name: (body as { name: string }).name }) }) }
    }
    // Swapping to the new id makes the builder REFETCH the plate by id — answer that
    // with the plate, not the list. Getting it wrong leaves `meal` undefined a beat
    // after the dish lands, which reads as "the Use button did nothing", and only
    // under load.
    if (/\/api\/meals\/[^/?]+$/.test(u) && method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          meal: PLATE({
            recipeCount: 1,
            recipes: [{ recipeId: 'r1', title: 'Chicken Parmesan', role: 'main' }] as never,
          }),
        }),
      }
    }
    if (u.includes('/api/meals') && method === 'GET') return { ok: true, json: async () => ({ meals: [] }) }
    if (/\/api\/meals\/[^/?]+$/.test(u) && method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderBrowser(props: Partial<React.ComponentProps<typeof RecipeBrowser>> = {}) {
  return render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <RecipeBrowser recipes={RECIPES} loading={false} slot="dinner" {...props} />
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sent.length = 0
  mockApi()
})

describe('RecipeBrowser — building a plate without leaving the slot', () => {
  it('offers a way to build a new plate while picking one', () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    expect(screen.getByRole('button', { name: /New meal/i })).toBeInTheDocument()
  })

  // The same render contract "＋ New recipe" follows: a caller with nowhere to
  // schedule a plate to (the plan-my-week draft overlay) doesn't advertise plates at
  // all.
  it('stays out of the way when plates aren’t on offer', () => {
    renderBrowser({ onPick: () => {} })
    expect(screen.queryByRole('button', { name: /New meal/i })).not.toBeInTheDocument()
  })

  it('builds the plate and hands it back for the slot in one go', async () => {
    const onPickMeal = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal })

    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    await screen.findByLabelText('Meal name')
    // A plate needs a dish before it can fill a night — the bar disables every action
    // on an empty one, this included.
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chicken Parmesan' }))
    // Deliberately no rename here: the name field debounces 600ms before writing, and
    // every bar action is disabled while a write is in flight, so renaming and racing
    // to click would test the debounce. The rename is covered below, where the
    // assertion is the request.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Use this plate/i }) as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /Use this plate/i }))

    await waitFor(() => expect(onPickMeal).toHaveBeenCalledTimes(1))
    expect(onPickMeal.mock.calls[0][0]).toMatchObject({ id: 'm-new' })
  })

  // A plate built here belongs in the library, like a recipe written here does — and
  // `isSaved` is what makes scheduling COPY it, so the library plate survives the
  // night being edited.
  it('saves the new plate to the library, under the name it was given', async () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    fireEvent.change(await screen.findByLabelText('Meal name'), { target: { value: 'Sunday Roast' } })
    // The plate is created lazily, on the first dish — not on the first keystroke.
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chicken Parmesan' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/meals$/.test(s.url))).toBe(true))
    const create = sent.find((s) => s.method === 'POST' && /\/api\/meals$/.test(s.url))!
    expect(create.body).toMatchObject({ name: 'Sunday Roast', isSaved: true })
  })

  // Scheduling and "add to grocery list" are the builder SCREEN's answers to "now
  // what?". In a picker the answer is the slot that opened it, so offering them would
  // be two ways to do one thing, one of which silently abandons the slot.
  it('offers no competing destination inside the picker', async () => {
    renderBrowser({ onPick: () => {}, onPickMeal: () => {} })
    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    await screen.findByLabelText('Meal name')
    expect(screen.queryByRole('button', { name: /^Schedule/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add plate to list/i })).toBeNull()
  })

  // The plate is created LAZILY, on the first dish, so a half-built one is a real
  // saved row by the time somebody changes their mind. Closing has to take it back
  // out, or every abandoned "＋ New meal" leaves a permanent empty plate in the
  // library.
  it('takes a half-built plate back out of the library when cancelled', async () => {
    const onPickMeal = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal })
    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    await screen.findByLabelText('Meal name')
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chicken Parmesan' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/meals$/.test(s.url))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(sent.some((s) => s.method === 'DELETE' && /\/api\/meals\/m-new$/.test(s.url))).toBe(true),
    )
    expect(onPickMeal).not.toHaveBeenCalled()
  })

  it('keeps the plate that was chosen', async () => {
    const onPickMeal = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal })
    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    await screen.findByLabelText('Meal name')
    fireEvent.click(await screen.findByRole('button', { name: 'Add Chicken Parmesan' }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Use this plate/i }) as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: /Use this plate/i }))
    await waitFor(() => expect(onPickMeal).toHaveBeenCalledTimes(1))
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false)
  })

  it('leaves the picker untouched when the plate is abandoned before anything is written', async () => {
    const onPickMeal = vi.fn()
    renderBrowser({ onPick: () => {}, onPickMeal })
    fireEvent.click(screen.getByRole('button', { name: /New meal/i }))
    await screen.findByLabelText('Meal name')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByLabelText('Meal name')).not.toBeInTheDocument())
    expect(onPickMeal).not.toHaveBeenCalled()
    expect(screen.getByText('Chicken Parmesan')).toBeInTheDocument()
    expect(sent.some((s) => s.method === 'POST')).toBe(false)
  })
})
