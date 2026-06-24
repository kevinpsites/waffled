import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotoAdd } from './PhotoAdd'

// Stub the api slice: uploadImage returns a unique key/url per call, and api.createPhoto
// records the inputs it was called with so we can assert the upload key + album flow.
const created: Record<string, unknown>[] = []
let uploadN = 0
const uploadImage = vi.fn(async () => {
  uploadN += 1
  return { key: `media/up${uploadN}.jpg`, url: `/media/up${uploadN}.jpg`, contentType: 'image/jpeg' }
})

vi.mock('../../lib/api', () => ({
  uploadImage: (...args: unknown[]) => uploadImage(...(args as [])),
  api: {
    createPhoto: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return { photo: { id: `p${created.length}` } }
    }),
  },
}))

beforeEach(() => {
  created.length = 0
  uploadN = 0
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

    // topbar button pluralizes
    fireEvent.click(screen.getByRole('button', { name: /Add 3 photos/i }))
    await waitFor(() => expect(created.length).toBe(3))
    expect(created.map((c) => c.storageKey)).toEqual(['media/up1.jpg', 'media/up2.jpg', 'media/up3.jpg'])
    expect(onAdded).toHaveBeenCalled()
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
