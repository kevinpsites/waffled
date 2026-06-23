import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { RecipeEditor } from './RecipeEditor'
import { TopbarSlotProvider } from './topbar-slot'

// Mock only uploadImage; keep the rest of the api slice real so mealsApi.createRecipe
// still goes through the fetch mock below (so we can assert the storageKey in the POST).
const uploadImage = vi.fn(async () => ({ key: 'media/up.jpg', url: '/media/up.jpg', contentType: 'image/jpeg' }))
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ...actual, uploadImage: (...a: unknown[]) => uploadImage(...(a as [])) }
})

interface Sent { method: string; url: string; body: unknown }

function mockFetch(sent: Sent[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
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

// A recipe already carrying an uploaded blob — the GET the editor loads in edit mode.
const EXISTING = {
  id: 'edit-id', title: 'Existing', emoji: null, description: null, category: null, tags: [],
  prepTimeMinutes: null, cookTimeMinutes: null, servings: 4,
  imageUrl: '/media/existing.jpg', storageKey: 'media/existing.jpg', sourceName: null,
  isFavorite: false, cookedCount: 0, lastCookedAt: null, notes: null, userNotes: null,
  addedTags: [], overrides: {}, mealType: null, protein: null, base: null, cuisine: null,
  effort: null, cookMethod: null, flavorProfile: null, dietary: [], vegetables: [], collection: null,
}

function mockEditFetch(sent: Sent[]) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ method, url: u, body })
    if (u.endsWith('/api/recipes/edit-id') && method === 'GET') {
      return { ok: true, json: async () => ({ recipe: EXISTING, ingredients: [], steps: [] }) }
    }
    if (u.endsWith('/api/recipes/edit-id') && method === 'PATCH') {
      return { ok: true, json: async () => ({ recipe: EXISTING }) }
    }
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

describe('RecipeEditor — photo upload', () => {
  beforeEach(() => uploadImage.mockClear())

  // Regression: a plain edit (no image change) must RE-SEND the existing storageKey,
  // not null — otherwise saving any recipe with a photo silently wiped the image.
  it('preserves the existing uploaded image when editing without re-uploading', async () => {
    const sent: Sent[] = []
    mockEditFetch(sent)
    renderEdit()

    await screen.findByDisplayValue('Existing')
    // the existing image is restored as a preview, no re-upload performed
    await screen.findByAltText('Recipe preview')
    expect(uploadImage).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Existing edited' } })
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH')!
    const b = patch.body as { storageKey: string | null; imageUrl: string | null; title: string }
    expect(b.title).toBe('Existing edited')
    expect(b.storageKey).toBe('media/existing.jpg')
  })

  it('uploads a file and sends the returned key as storageKey in the create payload', async () => {
    const sent: Sent[] = []
    mockFetch(sent)
    renderNew()

    fireEvent.change(screen.getByPlaceholderText('Recipe title'), { target: { value: 'Photo Recipe' } })

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'p.jpg', { type: 'image/jpeg' })] } })

    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    await screen.findByAltText('Recipe preview')

    fireEvent.click(screen.getByText('Create recipe'))

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')).toBe(true))
    const post = sent.find((s) => s.url.endsWith('/api/recipes') && s.method === 'POST')!
    expect((post.body as { storageKey: string }).storageKey).toBe('media/up.jpg')
  })
})
