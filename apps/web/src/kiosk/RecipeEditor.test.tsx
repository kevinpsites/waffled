import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipeEditor } from './RecipeEditor'
import { TopbarSlotProvider } from './topbar-slot'

interface Sent { method: string; url: string; body: unknown }

function mockApi(sent: Sent[], parsed?: unknown) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/recipes/parse-markdown') && method === 'POST') {
      return { ok: true, json: async () => parsed }
    }
    if (u.endsWith('/api/recipes') && method === 'POST') {
      return { ok: true, json: async () => ({ recipe: { id: 'new-id', title: body.title } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderNew() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipe/new']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipe/new" element={<RecipeEditor />} />
          <Route path="/meals/recipe/:id" element={<div>recipe page</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

describe('RecipeEditor — new', () => {
  it('builds the create payload from the form (title, ingredient, step)', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Test Soup' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'carrots' } })
    fireEvent.change(screen.getByPlaceholderText('2'), { target: { value: '3' } })
    fireEvent.change(screen.getByPlaceholderText('cups'), { target: { value: 'cups' } })
    fireEvent.change(screen.getByPlaceholderText('Describe this step…'), { target: { value: 'Simmer everything.' } })

    // Pick the ingredient as a step chip (no retyping); default amount is "3 cups".
    fireEvent.click(screen.getByText('+ carrots'))

    fireEvent.click(screen.getByText('Create recipe'))

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const post = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!
    const b = post.body as { title: string; ingredients: { name: string; amount: number }[]; steps: { instruction: string; ingredients: string[] }[] }
    expect(b.title).toBe('Test Soup')
    expect(b.ingredients).toHaveLength(1)
    expect(b.ingredients[0]).toMatchObject({ name: 'carrots', amount: 3 })
    expect(b.steps).toHaveLength(1)
    expect(b.steps[0].instruction).toBe('Simmer everything.')
    expect(b.steps[0].ingredients).toEqual(['3 cups carrots'])
  })

  it('per-step amount can be split (override the chip amount)', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Water Test' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'water' } })
    fireEvent.change(screen.getByPlaceholderText('2'), { target: { value: '2' } })
    fireEvent.change(screen.getByPlaceholderText('cups'), { target: { value: 'cups' } })
    fireEvent.change(screen.getByPlaceholderText('Describe this step…'), { target: { value: 'Add half the water.' } })

    fireEvent.click(screen.getByText('+ water'))
    // override the prefilled "2 cups" down to "1 cup" for this step
    fireEvent.change(screen.getByLabelText('Amount of water for this step'), { target: { value: '1 cup' } })

    fireEvent.click(screen.getByText('Create recipe'))
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const b = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!.body as { steps: { ingredients: string[] }[] }
    expect(b.steps[0].ingredients).toEqual(['1 cup water'])
  })

  it('paste → parse prefills the form', async () => {
    const sent: Sent[] = []
    mockApi(sent, {
      recipe: { title: 'Parsed Dish', emoji: '🍲', servings: 2, tags: [], notes: null, sourceName: null, mealType: 'dinner', protein: null, base: null, cuisine: 'Thai', effort: null, cookMethod: null, flavorProfile: null, dietary: [], vegetables: [] },
      ingredients: [{ name: 'rice', amount: 1, unit: 'cup', prepNote: null, section: null }],
      steps: [{ instruction: 'Cook the rice.', ingredients: [] }],
    })
    renderNew()

    fireEvent.click(screen.getByText('📋 Paste markdown'))
    fireEvent.change(screen.getByPlaceholderText('Paste frontmatter + markdown here…'), { target: { value: '# Parsed Dish' } })
    fireEvent.click(screen.getByText('Parse → fill the form'))

    await waitFor(() => expect((screen.getByPlaceholderText('Recipe title') as HTMLInputElement).value).toBe('Parsed Dish'))
    expect((screen.getByPlaceholderText('ingredient') as HTMLInputElement).value).toBe('rice')
    expect((screen.getByPlaceholderText('Describe this step…') as HTMLTextAreaElement).value).toBe('Cook the rice.')
  })
})
