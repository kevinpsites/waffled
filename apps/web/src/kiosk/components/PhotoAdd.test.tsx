import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotoAdd } from './PhotoAdd'

// Stub the api slice: uploadImage returns a fixed key/url, and api.createPhoto records
// the inputs it was called with so we can assert the upload key flows through as storageKey.
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
    await screen.findByPlaceholderText('Caption')
    expect(uploadImage).toHaveBeenCalledTimes(1)

    const addBtn = screen.getByRole('button', { name: /Add.*photos/i })
    fireEvent.click(addBtn)

    await waitFor(() => expect(created.length).toBe(1))
    expect(created[0]).toMatchObject({ storageKey: 'media/up.jpg' })
    expect(created[0].imageUrl).toBeUndefined()
  })
})
