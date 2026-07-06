import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { CookMode } from './CookMode'
import { TopbarSlotProvider } from './topbar-slot'

interface StepInput {
  stepNumber: number
  instruction: string
  ingredients?: string[]
  note?: string | null
  timerSeconds?: number | null
}

// Mock the recipe GET so useRecipe resolves with the steps we care about.
function mockRecipe(steps: StepInput[]) {
  const recipe = { id: 'r1', title: 'Test Recipe' }
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.endsWith('/api/recipes/r1') && method === 'GET') {
      return {
        ok: true,
        json: async () => ({
          recipe,
          ingredients: [],
          steps: steps.map((s) => ({
            stepNumber: s.stepNumber,
            instruction: s.instruction,
            ingredients: s.ingredients ?? [],
            note: s.note ?? null,
            timerSeconds: s.timerSeconds ?? null,
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

describe('CookMode — on-the-spot timer', () => {
  it('shows the "Add timer" affordance on a step with no built-in timer', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions', timerSeconds: null }])
    renderCook()
    await screen.findByText('Chop the onions')
    // No built-in Start button on this step.
    expect(screen.queryByRole('button', { name: /^⏱ Start/ })).toBeNull()
    // The add-timer control is present.
    expect(screen.getByRole('button', { name: /add timer/i })).toBeTruthy()
  })

  it('keeps the built-in Start button on a step that already has a timer', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Simmer the sauce', timerSeconds: 600 }])
    renderCook()
    await screen.findByText('Simmer the sauce')
    // Built-in start button shows the formatted duration; no add-timer affordance.
    expect(screen.getByRole('button', { name: /⏱ Start 10:00/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /add timer/i })).toBeNull()
  })

  it('starts a running timer tied to the current step and shows it in the dock', async () => {
    mockRecipe([{ stepNumber: 1, instruction: 'Chop the onions', timerSeconds: null }])
    renderCook()
    await screen.findByText('Chop the onions')

    // Open the add-timer control.
    fireEvent.click(screen.getByRole('button', { name: /add timer/i }))

    // Enter 5 minutes 30 seconds.
    const min = screen.getByLabelText(/minutes/i) as HTMLInputElement
    const sec = screen.getByLabelText(/seconds/i) as HTMLInputElement
    fireEvent.change(min, { target: { value: '5' } })
    fireEvent.change(sec, { target: { value: '30' } })

    // Confirm — starts the timer.
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))

    // The running timer appears in the dock labelled for this step.
    await waitFor(() => {
      const dock = screen.getByRole('status')
      expect(dock.textContent).toContain('Step 1')
      expect(dock.textContent).toContain('5:30')
    })
    // It can be paused (dock renders pause/dismiss controls) — proving it's a real running timer.
    expect(screen.getByRole('button', { name: /pause timer/i })).toBeTruthy()
  })
})
