// The "add to grocery" picker's pre-uncheck rule.
//
// Two defaults live here and they are NOT the same rule, which is the whole reason this
// file exists:
//
//   inPantry → UNCHECKED. A real match against the pantry inventory. We observed it.
//   isStaple → CHECKED.   A standing assumption that the household keeps this around.
//                         Never observed, so it must not silently drop off the list.
//
// Conflating the two would quietly reverse a deliberate product decision (an item missing
// at the shop costs more than an extra one to uncheck), so the staple case is asserted
// here as a guard, not just for coverage.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RecipeGroceryModal } from './RecipeGroceryModal'
import type { RecipeIngredient } from '../../lib/api'

const ing = (id: string, name: string, extra: Partial<RecipeIngredient> = {}): RecipeIngredient => ({
  id,
  name,
  amount: 1,
  unit: null,
  prepNote: null,
  display: null,
  section: null,
  aisle: null,
  isStaple: false,
  sortOrder: null,
  sub: null,
  ...extra,
})

// Captures the ingredientIds the modal posts, which is the actual contract under test.
function mockAdd() {
  const posted: string[][] = []
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    if (String(url).includes('/api/lists/grocery/from-recipe/')) {
      posted.push(JSON.parse(opts!.body!).ingredientIds)
      return { ok: true, json: async () => ({ added: 1 }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return posted
}

const show = (ingredients: RecipeIngredient[]) =>
  render(
    <RecipeGroceryModal
      recipeId="r1"
      title="Chowder"
      ingredients={ingredients}
      onClose={() => {}}
      onAdded={() => {}}
    />
  )

// The row's ✓ cell is empty when unchecked — the checkmark is the state.
const checked = (name: string): boolean => {
  const row = screen.getByText(name).closest('.ring-row')!
  return row.querySelector('.ring-ck')!.textContent === '✓'
}

describe('RecipeGroceryModal — pantry pre-uncheck', () => {
  it('pre-unchecks an ingredient the pantry says you have', () => {
    show([ing('1', 'Leeks'), ing('2', 'Heavy cream', { inPantry: true })])
    expect(checked('Leeks')).toBe(true)
    expect(checked('Heavy cream')).toBe(false)
  })

  it('keeps staples CHECKED — an assumption must not drop items silently', () => {
    show([ing('1', 'Leeks'), ing('2', 'Olive oil', { isStaple: true })])
    expect(checked('Olive oil')).toBe(true)
    // ...and it keeps the softer hint, not the pantry one.
    expect(screen.getByText(/likely on hand/)).toBeInTheDocument()
    expect(screen.queryByText(/in your pantry/)).not.toBeInTheDocument()
  })

  it('shows the real match instead of the staple guess when both apply', () => {
    show([ing('1', 'Rice', { isStaple: true, inPantry: true })])
    expect(screen.getByText(/in your pantry/)).toBeInTheDocument()
    expect(screen.queryByText(/likely on hand/)).not.toBeInTheDocument()
    // The observation wins the default too.
    expect(checked('Rice')).toBe(false)
  })

  it('posts only the checked ids', async () => {
    const posted = mockAdd()
    show([ing('1', 'Leeks'), ing('2', 'Heavy cream', { inPantry: true })])
    fireEvent.click(screen.getByRole('button', { name: /Add 1 item/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual(['1'])
  })

  it('lets you take a pantry item back with one tap', async () => {
    const posted = mockAdd()
    show([ing('1', 'Leeks'), ing('2', 'Heavy cream', { inPantry: true })])
    fireEvent.click(screen.getByText('Heavy cream'))
    expect(checked('Heavy cream')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Add 2 items/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.sort()).toEqual(['1', '2'])
  })

  it('says how many it unchecked, so the change is never silent', () => {
    show([ing('1', 'Leeks'), ing('2', 'Heavy cream', { inPantry: true })])
    expect(screen.getByText(/already unchecked 1 item your pantry says you have/)).toBeInTheDocument()
  })

  it('names the state rather than offering a dead "Add 0 items" when the pantry covers everything', () => {
    show([ing('1', 'Leeks', { inPantry: true }), ing('2', 'Heavy cream', { inPantry: true })])
    expect(screen.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
    // "Select all" is the way out.
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: /Add 2 items/ })).toBeEnabled()
  })

  it('behaves exactly as before when the server sends no pantry data', () => {
    // Pantry module off / older server: inPantry absent everywhere → all checked.
    show([ing('1', 'Leeks'), ing('2', 'Heavy cream'), ing('3', 'Olive oil', { isStaple: true })])
    expect(screen.getByRole('button', { name: /Add 3 items/ })).toBeEnabled()
    expect(screen.getByText(/uncheck anything you already have/)).toBeInTheDocument()
  })
})
