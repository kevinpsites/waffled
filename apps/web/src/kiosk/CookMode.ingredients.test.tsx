import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { CookMode } from './CookMode'
import { TopbarSlotProvider } from './topbar-slot'

// Cooking is a checklist you work through, so the ingredients are one: tick each off
// as it goes in. A step's chips and the full list are two views of the same
// ingredient, so ticking either ticks both — and a tick has to survive walking
// between steps (and, on a plate, switching dishes) or it's worse than useless.

interface StepInput {
  stepNumber: number
  instruction: string
  ingredients?: string[]
}

function ing(id: string, name: string, amount: number | null = null, unit: string | null = null) {
  return {
    id, name, amount, unit,
    prepNote: null, display: null, section: null, aisle: null,
    isStaple: false, sortOrder: null, sub: null,
  }
}

const INGS = [ing('i1', 'onion', 2, null), ing('i2', 'olive oil', 3, 'tbsp'), ing('i3', 'garlic', 4, 'cloves')]

function mockRecipe(steps: StepInput[], ingredients = INGS) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/api/recipes/r1') && method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          recipe: { id: 'r1', title: 'Test Recipe' },
          ingredients,
          steps: steps.map((s) => ({
            stepNumber: s.stepNumber,
            instruction: s.instruction,
            ingredients: s.ingredients ?? [],
            note: null,
            timerSeconds: null,
          })),
        }),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderCook() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipe/r1/cook']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipe/:id/cook" element={<CookMode />} />
          <Route path="/meals/recipe/:id" element={<div>recipe page</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

const openAll = async () => fireEvent.click(await screen.findByRole('button', { name: /All ingredients/i }))
const closeAll = () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))
// A chip and its list row deliberately read the same ("4 cloves garlic"), so every
// query says which of the two it means.
const list = () => within(document.querySelector('.modal-card') as HTMLElement)
const stage = () => within(document.querySelector('.cm-stage') as HTMLElement)

describe('CookMode — ingredients you can tick off', () => {
  it('ticks an ingredient off the full list', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions' }])
    renderCook()
    await openAll()

    expect(list().getByRole('checkbox', { name: /onion/i })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(list().getByRole('checkbox', { name: /onion/i }))
    expect(list().getByRole('checkbox', { name: /onion/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('ticks back off again', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions' }])
    renderCook()
    await openAll()

    fireEvent.click(list().getByRole('checkbox', { name: /garlic/i }))
    expect(list().getByRole('checkbox', { name: /garlic/i })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(list().getByRole('checkbox', { name: /garlic/i }))
    expect(list().getByRole('checkbox', { name: /garlic/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('shows a step chip as ticked once its ingredient is ticked in the full list', async () => {
    // The chip is free text ("2 onions") and the list row is a row with an id — the
    // same ingredient seen twice, so one tick has to cover both.
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions', ingredients: ['2 onions'] }])
    renderCook()
    await openAll()
    fireEvent.click(list().getByRole('checkbox', { name: /onion/i }))
    closeAll()

    expect(stage().getByRole('checkbox', { name: '2 onions' })).toHaveAttribute('aria-checked', 'true')
  })

  it('ticks an ingredient straight off the step chip', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Sweat the garlic', ingredients: ['4 cloves garlic'] }])
    renderCook()
    await screen.findByText('Sweat the garlic')

    fireEvent.click(stage().getByRole('checkbox', { name: '4 cloves garlic' }))
    expect(stage().getByRole('checkbox', { name: '4 cloves garlic' })).toHaveAttribute('aria-checked', 'true')

    // ...and the full list agrees.
    await openAll()
    expect(list().getByRole('checkbox', { name: /garlic/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps ticks while you walk through the steps', async () => {
    mockRecipe([
      { stepNumber: 1, instruction: 'Chop the onions', ingredients: ['2 onions'] },
      { stepNumber: 2, instruction: 'Warm the oil', ingredients: ['3 tbsp olive oil'] },
    ])
    renderCook()
    await screen.findByText('Chop the onions')
    fireEvent.click(stage().getByRole('checkbox', { name: '2 onions' }))

    fireEvent.click(screen.getByRole('button', { name: /Next/i }))
    await screen.findByText('Warm the oil')
    fireEvent.click(screen.getByRole('button', { name: /Back/i }))
    await screen.findByText('Chop the onions')

    expect(stage().getByRole('checkbox', { name: '2 onions' })).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves an unmatched chip tickable on its own', async () => {
    // A step can name something the ingredient list never listed ("a pinch of salt").
    // It still gets ticked off — it just isn't tied to a list row.
    mockRecipe([{ stepNumber: 1, instruction: 'Season it', ingredients: ['a pinch of salt'] }])
    renderCook()
    await screen.findByText('Season it')

    fireEvent.click(stage().getByRole('checkbox', { name: 'a pinch of salt' }))
    expect(stage().getByRole('checkbox', { name: 'a pinch of salt' })).toHaveAttribute('aria-checked', 'true')

    await openAll()
    // Nothing on the real list got ticked by it.
    expect(list().getByRole('checkbox', { name: /onion/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('counts what is left to gather', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions' }])
    renderCook()
    await openAll()

    expect(list().getByText('0 of 3')).toBeInTheDocument()
    fireEvent.click(list().getByRole('checkbox', { name: /onion/i }))
    expect(list().getByText('1 of 3')).toBeInTheDocument()
  })
})
