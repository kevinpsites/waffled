import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotoAdd } from './PhotoAdd'

// Stub the api slice: uploadImage returns a fixed key/url, and api.createPhoto records
// the inputs it was called with so we can assert the upload key + album flow through.
const created: Record<string, unknown>[] = []
const uploadImage = vi.fn(async () => ({ key: 'media/up.jpg', url: '/media/up.jpg', contentType: 'image/jpeg' }))

vi.mock('../../lib/api', () => ({
  uploadImage: (...args: unknown[]) => uploadImage(...(args as [])),
  api: {
    createPhoto: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input)
      return { photo: { id: 'p1' } }
    }),
  },
}))

beforeEach(() => {
  created.length = 0
  uploadImage.mockClear()
})

function pickFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('PhotoAdd — upload', () => {
  it('uploads a chosen file and passes the returned key as storageKey to createPhoto', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)

    pickFile()

    // preview + caption appear once upload resolves
    await screen.findByPlaceholderText('Add a caption…')
    expect(uploadImage).toHaveBeenCalledTimes(1)

    const addBtn = screen.getByRole('button', { name: /Add photo/i })
    fireEvent.click(addBtn)

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({ storageKey: 'media/up.jpg' })
    expect(created[0].imageUrl).toBeUndefined()
  })

  it('sends the entered caption + album (as memory) to createPhoto', async () => {
    const onAdded = vi.fn()
    render(<PhotoAdd onClose={() => {}} onAdded={onAdded} albums={['Lake Day']} />)

    pickFile()
    const caption = (await screen.findByPlaceholderText('Add a caption…')) as HTMLInputElement
    fireEvent.change(caption, { target: { value: 'Sandcastle' } })
    // Album is now an AlbumPicker: choose "＋ New album…", then type a new name.
    const albumSelect = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(albumSelect, { target: { value: '__new__' } })
    const albumInput = screen.getByPlaceholderText('New album name') as HTMLInputElement
    fireEvent.change(albumInput, { target: { value: 'Beach Trip' } })

    fireEvent.click(screen.getByRole('button', { name: /Add photo/i }))

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({
      storageKey: 'media/up.jpg',
      caption: 'Sandcastle',
      memory: 'Beach Trip',
      isFavorite: false,
    })
    expect(onAdded).toHaveBeenCalled()
  })

  it('marks the photo favorite when the heart is toggled', async () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)

    pickFile()
    await screen.findByPlaceholderText('Add a caption…')
    fireEvent.click(screen.getByRole('button', { name: /Favorite/i }))
    fireEvent.click(screen.getByRole('button', { name: /Add photo/i }))

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({ isFavorite: true })
  })

  it('shows a muted, non-clickable Shared album "soon" source', () => {
    render(<PhotoAdd onClose={() => {}} onAdded={() => {}} />)
    expect(screen.getByText(/Shared album/)).toBeInTheDocument()
    expect(screen.getByText('coming soon')).toBeInTheDocument()
  })
})
