import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipeEditor } from './RecipeEditor'
import { TopbarSlotProvider } from './topbar-slot'

interface Sent { method: string; url: string; body: unknown }

function mockApi(sent: Sent[], parsed?: unknown, suggest?: unknown) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/recipes/parse-markdown') && method === 'POST') {
      return { ok: true, json: async () => parsed }
    }
    if (u.endsWith('/api/recipes/suggest-metadata') && method === 'POST') {
      if (!suggest) return { ok: false, status: 501, json: async () => ({}) }
      return { ok: true, json: async () => suggest }
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

// ── edit mode ──
// A saved recipe as the detail GET returns it; `recipe`/`ingredients` are overridden
// per test so a test can feed back exactly what the previous save sent.
function makeDetail(recipe: Record<string, unknown> = {}, ingredients: Record<string, unknown>[] = []) {
  return {
    recipe: {
      id: 'edit-id', title: 'Saved Recipe', emoji: null, description: null, category: null, tags: [],
      prepTimeMinutes: null, cookTimeMinutes: null, servings: 4,
      imageUrl: null, storageKey: null, sourceName: null,
      isFavorite: false, cookedCount: 0, lastCookedAt: null, notes: null, userNotes: null,
      addedTags: [], overrides: {}, mealType: null, protein: null, base: null, cuisine: null,
      effort: null, cookMethod: null, flavorProfile: null, dietary: [], vegetables: [], collection: null,
      ...recipe,
    },
    ingredients: ingredients.map((i, n) => ({ id: `i${n}`, name: 'ingredient', amount: null, unit: null, prepNote: null, section: null, ...i })),
    steps: [] as unknown[],
  }
}

function mockEditApi(sent: Sent[], detail: ReturnType<typeof makeDetail>) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/recipes/edit-id') && method === 'GET') return { ok: true, json: async () => detail }
    if (u.endsWith('/api/recipes/edit-id') && method === 'PATCH') return { ok: true, json: async () => ({ recipe: detail.recipe }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/meals/recipe/edit-id/edit']}>
      <TopbarSlotProvider>
        <Routes>
          <Route path="/meals/recipe/:id/edit" element={<RecipeEditor />} />
          <Route path="/meals/recipe/:id" element={<div>recipe page</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>,
  )
}

// Two columns, two boxes: `notes` belongs to the recipe (and is what a re-import
// rewrites), `userNotes` is the household's own note on it. Editing a recipe used to
// prefill ONE box from userNotes and save it back into notes — duplicating personal
// notes into the shared column, where the recipe page then showed them twice.
describe('RecipeEditor — edit: recipe notes vs your notes', () => {
  it('prefills each column into its own field', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ notes: 'Soak the lentils overnight.', userNotes: 'Kids love it — double it.' }))
    renderEdit()

    await screen.findByDisplayValue('Saved Recipe')
    expect((screen.getByLabelText('Recipe notes') as HTMLTextAreaElement).value).toBe('Soak the lentils overnight.')
    expect((screen.getByLabelText('Your notes') as HTMLTextAreaElement).value).toBe('Kids love it — double it.')
  })

  it('does not copy personal notes into the shared notes column on save', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ notes: null, userNotes: 'Use less salt.' }))
    renderEdit()

    await screen.findByDisplayValue('Saved Recipe')
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Use much less salt.' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const b = sent.find((s) => s.method === 'PATCH')!.body as { notes: string | null; userNotes?: string }
    expect(b.notes).toBeNull() // the source's notes stay empty
    expect(b.userNotes).toBe('Use much less salt.') // personal notes stay personal
  })

  // Lost update: the editor holds the note it loaded with. Someone else's note —
  // written from the recipe page's blur-autosave or the iOS app while this editor sat
  // open — must not be overwritten by a save that never touched the notes box.
  it('leaves an untouched note alone instead of writing back a stale copy', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ notes: null, userNotes: 'Written elsewhere.' }))
    renderEdit()

    await screen.findByDisplayValue('Saved Recipe')
    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Renamed Recipe' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const b = sent.find((s) => s.method === 'PATCH')!.body as Record<string, unknown>
    expect(b.title).toBe('Renamed Recipe')
    expect('userNotes' in b).toBe(false) // the column is left exactly as the server has it
  })

  it('saves an edit to each field into its own column', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ notes: 'Soak overnight.', userNotes: 'Double the batch.' }))
    renderEdit()

    await screen.findByDisplayValue('Saved Recipe')
    fireEvent.change(screen.getByLabelText('Recipe notes'), { target: { value: 'Soak overnight, then rinse.' } })
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'Triple the batch.' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const b = sent.find((s) => s.method === 'PATCH')!.body as { notes: string | null; userNotes?: string }
    expect(b.notes).toBe('Soak overnight, then rinse.')
    expect(b.userNotes).toBe('Triple the batch.')
  })

  // The API only writes user_notes when it's a string — sending null would silently
  // keep the old note, so clearing the box has to send ''.
  it('can clear your notes', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ notes: null, userNotes: 'Was useful once.' }))
    renderEdit()

    await screen.findByDisplayValue('Saved Recipe')
    fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const b = sent.find((s) => s.method === 'PATCH')!.body as { userNotes?: string }
    expect(b.userNotes).toBe('')
  })
})

// Same failure mode the save path just fixed: the confirm dialog closes either way, so
// a delete that never happened reads exactly like one that did.
describe('RecipeEditor — edit: delete', () => {
  it('shows an error when the delete fails instead of looking deleted', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ title: 'Keeper' })) // DELETE isn't handled → 500-ish
    renderEdit()

    await screen.findByDisplayValue('Keeper')
    fireEvent.click(screen.getByText('🗑 Delete recipe'))
    fireEvent.click(screen.getByText('Delete'))

    expect(await screen.findByText(/Couldn’t delete/)).toBeTruthy()
    // still on the editor with the recipe on screen
    expect(screen.getByDisplayValue('Keeper')).toBeTruthy()
  })
})

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

    // Tag the ingredient onto the step via the popover (no retyping); default amount "3 cups".
    fireEvent.click(screen.getByText('+ Tag ingredient'))
    fireEvent.click(screen.getByLabelText('Tag carrots'))

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

  // Regression: `Number('1/2')` is NaN, which the editor saved as null — the quantity
  // silently disappeared from the recipe.
  it('keeps a fractional quantity instead of dropping it', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Pancakes' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'flour' } })
    fireEvent.change(screen.getByPlaceholderText('2'), { target: { value: '1 1/2' } })
    fireEvent.change(screen.getByPlaceholderText('cups'), { target: { value: 'cups' } })

    fireEvent.click(screen.getByText('Create recipe'))
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const b = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!.body as {
      ingredients: { name: string; amount: number | null; unit: string | null }[]
    }
    expect(b.ingredients[0]).toMatchObject({ name: 'flour', amount: 1.5, unit: 'cups' })
  })

  // The whole point: what a save sends must survive being loaded back and re-saved.
  it('round-trips a fractional quantity through save → reload → save', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    const first = renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Pancakes' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'flour' } })
    fireEvent.change(screen.getByPlaceholderText('2'), { target: { value: '1 1/2' } })
    fireEvent.change(screen.getByPlaceholderText('cups'), { target: { value: 'cups' } })
    fireEvent.click(screen.getByText('Create recipe'))

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const created = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!.body as {
      ingredients: { name: string; amount: number | null; unit: string | null }[]
    }
    first.unmount()

    // Reload the editor on exactly what was saved — not a hand-written fixture.
    const sent2: Sent[] = []
    mockEditApi(sent2, makeDetail({ title: 'Pancakes' }, [created.ingredients[0] as Record<string, unknown>]))
    renderEdit()

    await screen.findByDisplayValue('Pancakes')
    // Prefill shows the amount the way it was typed, not the stored decimal.
    expect((screen.getByPlaceholderText('2') as HTMLInputElement).value).toBe('1½')

    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(sent2.some((s) => s.method === 'PATCH')).toBe(true))
    const patched = sent2.find((s) => s.method === 'PATCH')!.body as { ingredients: { amount: number | null }[] }
    expect(patched.ingredients[0].amount).toBe(1.5)
  })

  // A third of a cup is stored as 0.3333333333333333. Re-opening the editor used to
  // paste that straight into the Qty box; a save from there is exact but unreadable.
  it('re-opens an awkward fraction as the fraction, not its decimal', async () => {
    const sent: Sent[] = []
    mockEditApi(sent, makeDetail({ title: 'Dressing' }, [{ name: 'oil', amount: 1 / 3, unit: 'cup' }]))
    renderEdit()

    await screen.findByDisplayValue('Dressing')
    expect((screen.getByPlaceholderText('2') as HTMLInputElement).value).toBe('⅓')

    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patched = sent.find((s) => s.method === 'PATCH')!.body as { ingredients: { amount: number | null }[] }
    expect(patched.ingredients[0].amount).toBeCloseTo(1 / 3, 10)
  })

  // A brand-new recipe has no "source" to keep notes apart from — one box, into `notes`.
  it('keeps a single Notes box that writes the recipe notes', async () => {
    const sent: Sent[] = []
    mockApi(sent)
    renderNew()

    expect(screen.queryByLabelText('Your notes')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Noted Soup' } })
    fireEvent.change(screen.getByPlaceholderText('Anything worth remembering…'), { target: { value: 'From Grandma.' } })
    fireEvent.click(screen.getByText('Create recipe'))

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const b = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!.body as { notes: string | null; userNotes?: string }
    expect(b.notes).toBe('From Grandma.')
    expect(b.userNotes).toBeUndefined()
  })

  // Regression: a failed save just re-enabled the button, so a lost recipe looked
  // exactly like a saved one.
  it('shows an error when the save fails, and lets you retry', async () => {
    const sent: Sent[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      sent.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: false, status: 500, json: async () => ({ error: 'ServerError' }) }
    }) as unknown as typeof fetch
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Doomed Soup' } })
    fireEvent.click(screen.getByText('Create recipe'))

    expect(await screen.findByText(/Couldn’t save/)).toBeTruthy()
    // still on the editor, button back to normal so the user can try again
    expect(screen.queryByText('recipe page')).toBeNull()
    expect((screen.getByText('Create recipe').closest('button') as HTMLButtonElement).disabled).toBe(false)
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

    fireEvent.click(screen.getByText('+ Tag ingredient'))
    fireEvent.click(screen.getByLabelText('Tag water'))
    // override the prefilled "2 cups" down to "1 cup" for this step (in the popover)
    fireEvent.change(screen.getByLabelText('Amount of water'), { target: { value: '1 cup' } })

    fireEvent.click(screen.getByText('Create recipe'))
    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const b = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!.body as { steps: { ingredients: string[] }[] }
    expect(b.steps[0].ingredients).toEqual(['1 cup water'])
  })

  it('quiet AI suggestion fills empty fields only and merges arrays', async () => {
    const sent: Sent[] = []
    mockApi(sent, undefined, {
      suggestion: {
        cuisine: 'Italian', mealType: 'dinner', protein: 'chicken', base: 'pasta',
        effort: null, cookMethod: 'stovetop', flavorProfile: null,
        dietary: ['gluten-free'], vegetables: ['spinach'], tags: ['quick'],
      },
      via: 'test',
    })
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Spaghetti' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'noodles' } })
    // pre-fill protein so we can prove it is NOT overwritten
    fireEvent.change(screen.getByPlaceholderText('chicken, beef, tofu…'), { target: { value: 'beef' } })

    // suggestions surface after the debounced background call; Keep all applies them
    const keepAll = await screen.findByText('Keep all', {}, { timeout: 4000 })
    fireEvent.click(keepAll)

    expect((screen.getByPlaceholderText('Italian, Thai…') as HTMLInputElement).value).toBe('Italian') // empty → filled
    expect((screen.getByPlaceholderText('chicken, beef, tofu…') as HTMLInputElement).value).toBe('beef') // yours → kept
    expect(screen.getByText('spinach')).toBeTruthy() // vegetable chip merged in
    expect(screen.getByText('gluten-free')).toBeTruthy()
  })

  it('accepts a single inline suggestion via ✓ without applying the others', async () => {
    const sent: Sent[] = []
    mockApi(sent, undefined, {
      suggestion: {
        cuisine: 'Italian', mealType: null, protein: null, base: 'pasta',
        effort: null, cookMethod: null, flavorProfile: null,
        dietary: [], vegetables: [], tags: [],
      },
      via: 'test',
    })
    renderNew()
    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Spaghetti' } })
    fireEvent.change(screen.getByPlaceholderText('ingredient'), { target: { value: 'noodles' } })

    await screen.findByLabelText('Use Italian', {}, { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Use Italian'))

    expect(screen.getByDisplayValue('Italian')).toBeTruthy() // cuisine accepted
    expect(screen.getByPlaceholderText('✨ pasta')).toBeTruthy() // base suggestion still pending
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

  it('paste → parse carries a step timer into the timer control', async () => {
    const sent: Sent[] = []
    mockApi(sent, {
      recipe: { title: 'Timed Dish', emoji: '🍲', servings: 2, tags: [], notes: null, sourceName: null, mealType: null, protein: null, base: null, cuisine: null, effort: null, cookMethod: null, flavorProfile: null, dietary: [], vegetables: [] },
      ingredients: [{ name: 'rice', amount: 1, unit: 'cup', prepNote: null, section: null }],
      steps: [{ instruction: 'Cook on the grill for 6 minutes.', ingredients: [], timerSeconds: 360 }],
    })
    renderNew()

    fireEvent.click(screen.getByText('📋 Paste markdown'))
    fireEvent.change(screen.getByPlaceholderText('Paste frontmatter + markdown here…'), { target: { value: '# Timed Dish' } })
    fireEvent.click(screen.getByText('Parse → fill the form'))

    // The parsed timerSeconds should surface as a "6:00" timer pill, not "Add timer".
    await waitFor(() => expect(screen.getByText('6:00')).toBeTruthy())
    expect(screen.queryByText('⏱ Add timer')).toBeNull()
  })
})
