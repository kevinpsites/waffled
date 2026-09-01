import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { RecipeBrowser } from './RecipeBrowser'
import { TopbarSlotProvider } from '../topbar-slot'
import type { Recipe } from '../../lib/api'

// Filling a slot from the week/month plan used to be a dead end when the recipe you
// wanted wasn't in the library yet: cancel the picker, walk to Recipes, create it,
// walk back, re-open the slot. The picker now writes the recipe itself and hands the
// saved one straight back to the caller, so the slot you opened is the slot it fills.

interface Sent { method: string; url: string; body: unknown }
const sent: Sent[] = []

function mockApi() {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/recipes') && method === 'POST') {
      return { ok: true, json: async () => ({ recipe: { ...makeRecipe({ id: 'new-id', title: (body as { title: string }).title }) } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

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

describe('RecipeBrowser — creating a recipe without leaving the slot', () => {
  it('offers a way to write a new recipe while picking one', () => {
    renderBrowser({ onPick: () => {} })
    expect(screen.getByRole('button', { name: /New recipe/i })).toBeInTheDocument()
  })

  it('stays out of the way when the browser is only browsing', () => {
    // The library screen has its own "New recipe" button in the topbar; a second one
    // inside the grid would be a duplicate.
    renderBrowser()
    expect(screen.queryByRole('button', { name: /New recipe/i })).not.toBeInTheDocument()
  })

  it('saves the recipe and selects it for the slot in one go', async () => {
    const onPick = vi.fn()
    renderBrowser({ onPick })

    fireEvent.click(screen.getByRole('button', { name: /New recipe/i }))
    const titleInput = await screen.findByPlaceholderText(/Recipe title/i)
    fireEvent.change(titleInput, { target: { value: 'Sunday Ragu' } })
    fireEvent.click(await screen.findByRole('button', { name: /Create recipe/i }))

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1))
    // The saved recipe — with the id the server gave it — is what fills the slot.
    expect(onPick.mock.calls[0][0]).toMatchObject({ id: 'new-id', title: 'Sunday Ragu' })
    expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/api/recipes'))).toBe(true)
  })

  it('leaves the picker open and untouched when the new recipe is abandoned', async () => {
    const onPick = vi.fn()
    renderBrowser({ onPick })

    fireEvent.click(screen.getByRole('button', { name: /New recipe/i }))
    await screen.findByPlaceholderText(/Recipe title/i)
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))

    await waitFor(() => expect(screen.queryByPlaceholderText(/Recipe title/i)).not.toBeInTheDocument())
    expect(onPick).not.toHaveBeenCalled()
    // Back to the picker, not stranded on a blank screen.
    expect(screen.getByText('Chicken Parmesan')).toBeInTheDocument()
    expect(sent.some((s) => s.method === 'POST')).toBe(false)
  })
})
