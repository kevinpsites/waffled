// Picking a saved plate for a slot. RecipeBrowser only lists plates when a caller
// supplies `onPickMeal` — the target date lives in the caller's closure, so the
// browser can't schedule one itself. Without this wiring the feature ships dark:
// the library knows about plates, but the planner's picker never shows them.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Meals } from './Meals'
import { TopbarSlotProvider } from './topbar-slot'

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

const bbqSunday = {
  id: 'm1',
  name: 'BBQ Sunday',
  servings: 6,
  isSaved: true,
  createdBy: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  recipeCount: 2,
  emojis: ['🍗', '🥔'],
  totalMinutes: 70,
  onHand: null,
  toBuy: 4,
  recipes: [
    { recipeId: 'r1', title: 'BBQ Chicken', emoji: '🍗', category: null, role: 'main', sortOrder: 0, prepTimeMinutes: null, cookTimeMinutes: 45, servings: 6, imageUrl: null, cook: null, onHand: null, toBuy: 3 },
    { recipeId: 'r2', title: 'Potato Salad', emoji: '🥔', category: null, role: 'side', sortOrder: 1, prepTimeMinutes: null, cookTimeMinutes: 25, servings: 6, imageUrl: null, cook: null, onHand: null, toBuy: 1 },
  ],
}

let scheduled: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  scheduled = []
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/schedule') && init?.method === 'POST') {
      scheduled.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
      return { ok: true, json: async () => ({ entry: {}, meal: bbqSunday }) }
    }
    if (u.includes('/api/meals/week')) return { ok: true, json: async () => ({ start: '', entries: [] }) }
    // The saved-meal library. Must be distinguished from /api/meals/week above.
    if (/\/api\/meals(\?|$)/.test(u)) return { ok: true, json: async () => ({ meals: [bbqSunday] }) }
    if (u.includes('/api/recipes')) return { ok: true, json: async () => ({ recipes: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

function renderMeals() {
  return render(
    <MemoryRouter initialEntries={['/meals']}>
      <TopbarSlotProvider>
        <Meals />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('scheduling a saved plate from the planner picker', () => {
  it('offers saved plates in the slot picker and schedules the chosen one to that slot', async () => {
    renderMeals()

    // Open the picker for Sunday dinner via that cell's empty "+".
    const addButtons = await screen.findAllByRole('button', { name: /add/i })
    fireEvent.click(addButtons[0])

    // The plate shows up alongside recipes.
    const plate = await screen.findByText('BBQ Sunday')
    expect(plate).toBeInTheDocument()

    fireEvent.click(plate)

    await waitFor(() => expect(scheduled.length).toBe(1))
    // Scheduled through the meal endpoint, carrying the slot's own date + mealType —
    // not the plain recipe plan endpoint.
    expect(scheduled[0].url).toContain('/api/meals/m1/schedule')
    expect(scheduled[0].body).toMatchObject({ date: ymd(sun) })
  })
})
