import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PlanWeek } from './PlanWeek'
import { TopbarSlotProvider } from '../topbar-slot'

// Build a Sunday-based week of Date objects, matching the grid window PlanWeek expects.
function weekFrom(sunday: Date): Date[] {
  const out: Date[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday)
    d.setDate(sunday.getDate() + i)
    out.push(d)
  }
  return out
}

// Capture every plan-week request body; everything else returns empty data so the
// persons/recipes hooks resolve.
function mockApi(planned: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/meals/plan-week') && init?.method === 'POST') {
      planned.push(JSON.parse(init.body!))
      return { ok: true, json: async () => ({ start: '', mealType: 'dinner', suggestions: [], via: 'test' }) }
    }
    return { ok: true, json: async () => ({ persons: [], recipes: [] }) }
  }) as unknown as typeof fetch
}

function renderPlanWeek() {
  const sunday = new Date(2026, 5, 7) // Sun Jun 7 2026 (local)
  return render(
    <TopbarSlotProvider>
      <PlanWeek startStr="2026-06-07" days={weekFrom(sunday)} onClose={() => {}} onApplied={() => {}} />
    </TopbarSlotProvider>
  )
}

describe('PlanWeek — Try New Recipe steering', () => {
  it('renders the "try something new" toggle and a "want to try" input', async () => {
    mockApi([])
    renderPlanWeek()
    // The toggle is now the shared .toggle pill (role="switch").
    expect(await screen.findByRole('switch', { name: /try something new/i })).toBeInTheDocument()
    expect(screen.getByText(/cuisines or dishes to try/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/thai green curry/i)).toBeInTheDocument()
  })

  it('passes trySomethingNew + wantToTry through to api.planWeek', async () => {
    const planned: unknown[] = []
    mockApi(planned)
    renderPlanWeek()

    // Toggle "try something new" (shared .toggle pill).
    fireEvent.click(await screen.findByText(/try something new this week/i))

    // Add a specific dish to try (chip input mirrors "Use up first").
    const input = screen.getByPlaceholderText(/thai green curry/i)
    fireEvent.change(input, { target: { value: 'Shakshuka' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Shakshuka')).toBeInTheDocument()

    // Kick off the draft.
    fireEvent.click(screen.getByRole('button', { name: /plan my week/i }))

    await waitFor(() => expect(planned).toHaveLength(1))
    expect(planned[0]).toMatchObject({ trySomethingNew: true, wantToTry: ['Shakshuka'] })
  })
})

describe('PlanWeek — tapping a suggested new recipe', () => {
  function mockApiWithSuggestion() {
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/api/meals/plan-week') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            start: '', mealType: 'dinner', via: 'test',
            // recipeId:null → a brand-new dish not in the library.
            suggestions: [{ date: '2026-06-08', mealType: 'dinner', title: 'Thai Green Curry', recipeId: null, emoji: '🍛', minutes: 30, servings: 4, note: 'Something new' }],
          }),
        }
      }
      return { ok: true, json: async () => ({ persons: [], recipes: [] }) }
    }) as unknown as typeof fetch
  }

  it('opens the "new recipe" info modal with a web-search link, not the recipe picker', async () => {
    mockApiWithSuggestion()
    renderPlanWeek()
    fireEvent.click(await screen.findByRole('button', { name: /plan my week/i }))

    // Tap the drafted card's title.
    fireEvent.click(await screen.findByText('Thai Green Curry'))

    // The info sheet explains it's new — not the "Choose a recipe" picker.
    expect(await screen.findByText(/isn.t in your library/i)).toBeInTheDocument()
    expect(screen.queryByText(/choose a recipe ·/i)).not.toBeInTheDocument()

    const link = screen.getByRole('link', { name: /search the web/i })
    expect(link.getAttribute('href')).toContain('google.com/search')
    expect(link.getAttribute('href')).toContain(encodeURIComponent('Thai Green Curry recipe'))
  })
})
