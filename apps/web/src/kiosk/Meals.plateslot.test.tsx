// Opening a slot that holds a whole plate. Every planner surface branched on
// `entry.recipeId` to decide what a tap means — but a meal-backed slot has
// `recipeId: null` and `mealId` set, so tapping a planned meal fell through to the
// "this slot is empty" path and opened the picker. The meal was on the calendar and
// there was no way to get back into it.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useParams } from 'react-router'
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
const wed = new Date(sun)
wed.setDate(sun.getDate() + 3)

const plateEntry = {
  id: 'e1',
  date: ymd(wed),
  mealType: 'dinner',
  title: 'BBQ Sunday',
  recipeId: null,
  mealId: 'm1',
  cook: null,
  recipe: null,
  meal: {
    id: 'm1',
    name: 'BBQ Sunday',
    servings: 6,
    recipes: [
      { recipeId: 'r1', title: 'BBQ Chicken', emoji: '🍗', role: 'main', sortOrder: 0 },
      { recipeId: 'r2', title: 'Potato Salad', emoji: '🥔', role: 'side', sortOrder: 1 },
    ],
  },
}

// A plain single-recipe slot, to prove the existing behaviour is untouched.
const recipeEntry = {
  id: 'e2',
  date: ymd(sun),
  mealType: 'dinner',
  title: 'Tomato Pasta',
  recipeId: 'r9',
  mealId: null,
  cook: null,
  recipe: { title: 'Tomato Pasta', emoji: '🍝', category: null, prepTimeMinutes: null, cookTimeMinutes: null, servings: 4, imageUrl: null },
  meal: null,
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/meals/week')) {
      return { ok: true, json: async () => ({ start: ymd(sun), entries: [plateEntry, recipeEntry] }) }
    }
    if (/\/api\/meals(\?|$)/.test(u)) return { ok: true, json: async () => ({ meals: [] }) }
    if (u.includes('/api/recipes')) return { ok: true, json: async () => ({ recipes: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
})

function Probe({ label }: { label: string }) {
  const { id } = useParams()
  return <div>{`${label}:${id}`}</div>
}

function renderMeals() {
  return render(
    <MemoryRouter initialEntries={['/meals']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals" element={<Meals />} />
          <Route path="/meals/build/:id" element={<Probe label="BUILDER" />} />
          <Route path="/meals/recipe/:id" element={<Probe label="RECIPE" />} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

describe('Meals planner — opening a slot that holds a plate', () => {
  it('opens the plate, not the slot picker', async () => {
    renderMeals()
    fireEvent.click(await screen.findByRole('button', { name: /Dinner: BBQ Sunday/i }))
    expect(await screen.findByText('BUILDER:m1')).toBeInTheDocument()
  })

  it('still opens the recipe for a plain single-recipe slot', async () => {
    renderMeals()
    fireEvent.click(await screen.findByRole('button', { name: /Dinner: Tomato Pasta/i }))
    expect(await screen.findByText('RECIPE:r9')).toBeInTheDocument()
  })
})
