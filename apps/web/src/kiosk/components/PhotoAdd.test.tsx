import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotoAdd } from './PhotoAdd'

// Stub the api slice: uploadImage returns a unique key/url per call, and api.createPhoto
// records the inputs it was called with so we can assert the upload key + album flow.
const created: Record<string, unknown>[] = []
const sentScopes: Array<string | null> = []
let uploadN = 0
let currentScope: string | null = 'session:account-a'
let afterSend: ((sentCount: number) => Promise<void>) | null = null
const uploadImage = vi.fn(async (_file?: File, _identityScope?: string | null) => {
  uploadN += 1
  return { key: `media/up${uploadN}.jpg`, url: `/media/up${uploadN}.jpg`, contentType: 'image/jpeg' }
})

vi.mock('../../lib/api', () => ({
  uploadImage: (...args: unknown[]) => uploadImage(...(args as [])),
}))

vi.mock('../../lib/api/client', () => ({
  currentIdentityScope: () => currentScope,
  apiSendForIdentity: vi.fn(async (
    identityScope: string | null,
    _method: string,
    _path: string,
    input: Record<string, unknown>
  ) => {
    if (identityScope !== currentScope) throw new Error('Principal changed before /api/photos could be sent')
    sentScopes.push(identityScope)
    created.push(input)
    await afterSend?.(created.length)
    return { photo: { id: `p${created.length}` } }
  }),
}))

beforeEach(() => {
  created.length = 0
  uploadN = 0
  currentScope = 'session:account-a'
  sentScopes.length = 0
  afterSend = null
  uploadImage.mockClear()
})

function pickFiles(...names: string[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const files = names.map((n) => new File(['x'], n, { type: 'image/jpeg' }))
  fireEvent.change(input, { target: { files } })
}

describe('PhotoAdd — upload', () => {
  it('uploads a chosen file and passes the returned key as storageKey to createPhoto', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)

    pickFiles('p.jpg')

    // a caption row appears once the upload resolves
    await screen.findByPlaceholderText('Add a caption…')
    expect(uploadImage).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /^Add photo$/i }))

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({ storageKey: 'media/up1.jpg' })
    expect(created[0].imageUrl).toBeUndefined()
  })

  it('stages multiple photos and creates one per row', async () => {
    const onAdded = vi.fn()
    render(<PhotoAdd onClose={() => {}} onAdded={onAdded} />)

    pickFiles('a.jpg', 'b.jpg', 'c.jpg')
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(3))
    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'session:account-a',
      'session:account-a',
      'session:account-a',
    ])

    // topbar button pluralizes
    fireEvent.click(screen.getByRole('button', { name: /Add 3 photos/i }))
    await waitFor(() => expect(created.length).toBe(3))
    expect(created.map((c) => c.storageKey)).toEqual(['media/up1.jpg', 'media/up2.jpg', 'media/up3.jpg'])
    expect(onAdded).toHaveBeenCalled()
  })

  it('does not continue a multi-photo save with a replacement principal', async () => {
    let releaseFirst!: () => void
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    afterSend = async (sentCount) => {
      if (sentCount === 1) await firstPending
    }
    const onAdded = vi.fn()
    render(<PhotoAdd onClose={() => {}} onAdded={onAdded} />)

    pickFiles('a.jpg', 'b.jpg')
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: /Add 2 photos/i }))
    await waitFor(() => expect(created.length).toBe(1))

    currentScope = 'session:account-b'
    releaseFirst()

    await waitFor(() => expect(screen.getByRole('button', { name: /Add 2 photos/i })).toBeEnabled())
    expect(created).toHaveLength(1)
    expect(sentScopes).toEqual(['session:account-a'])
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('applies the batch "Album for all" to every staged photo as memory', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} albums={['Lake Day']} />)

    pickFiles('a.jpg', 'b.jpg')
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(2))

    // The shared picker: choose "＋ New album…" then type a name.
    const shared = document.getElementById('ap-shared-album') as HTMLSelectElement
    fireEvent.change(shared, { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('New album name'), { target: { value: 'Beach Trip' } })

    fireEvent.click(screen.getByRole('button', { name: /Add 2 photos/i }))
    await waitFor(() => expect(created.length).toBe(2))
    expect(created.every((c) => c.memory === 'Beach Trip')).toBe(true)
  })

  it('lets a single photo override the batch album', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} albums={['Lake Day', 'Birthday']} />)

    pickFiles('a.jpg', 'b.jpg')
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(2))

    // Batch → Lake Day (propagates to both rows)
    fireEvent.change(document.getElementById('ap-shared-album') as HTMLSelectElement, { target: { value: 'Lake Day' } })

    // Per-row pickers are the comboboxes after the shared one; override the 2nd row → Birthday
    const rowSelects = screen.getAllByRole('combobox').filter((el) => el.id !== 'ap-shared-album')
    fireEvent.change(rowSelects[1], { target: { value: 'Birthday' } })

    fireEvent.click(screen.getByRole('button', { name: /Add 2 photos/i }))
    await waitFor(() => expect(created.length).toBe(2))
    expect(created[0].memory).toBe('Lake Day')
    expect(created[1].memory).toBe('Birthday')
  })

  it('marks a photo favorite when its heart is toggled', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)

    pickFiles('a.jpg')
    await screen.findByPlaceholderText('Add a caption…')
    fireEvent.click(screen.getByRole('button', { name: /Favorite/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Add photo$/i }))

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({ isFavorite: true })
  })

  it('removes a staged photo before it is created', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)

    pickFiles('a.jpg', 'b.jpg')
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(2))

    fireEvent.click(screen.getAllByRole('button', { name: /Remove photo/i })[0])
    await waitFor(() => expect(screen.getAllByPlaceholderText('Add a caption…').length).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: /^Add photo$/i }))
    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0].storageKey).toBe('media/up2.jpg')
  })
})
