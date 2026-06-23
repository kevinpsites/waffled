import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhotoDetail } from './PhotoDetail'
import type { Photo } from '../../lib/api'

// Stub the api slice: api.updatePhoto records the patch it was called with so we can
// assert the edited caption / album / favorite flow through.
const patched: Array<{ id: string; patch: Record<string, unknown> }> = []

vi.mock('../../lib/api', () => ({
  api: {
    updatePhoto: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      patched.push({ id, patch })
      return { id, ...patch }
    }),
    deletePhoto: vi.fn(async () => {}),
  },
}))

const photo: Photo = {
  id: 'ph1',
  imageUrl: null,
  caption: 'Beach day',
  emoji: '🏖️',
  colorHex: '#7fc1e8',
  memory: 'Lake Day',
  takenAt: '2026-05-31T15:00:00Z',
  isFavorite: false,
  reactions: {},
  uploadedBy: { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' },
  createdAt: '2026-05-31T15:00:00Z',
}

beforeEach(() => {
  patched.length = 0
})

function renderDetail() {
  return render(
    <PhotoDetail
      photo={photo}
      memoryCount={2}
      albums={['Lake Day', 'Birthday']}
      onClose={() => {}}
      onSetScreensaver={() => {}}
      onUpdated={onUpdated}
      onDeleted={() => {}}
    />
  )
}
const onUpdated = vi.fn()

describe('PhotoDetail', () => {
  it('no longer renders the reactions card', () => {
    renderDetail()
    expect(screen.queryByText('Reactions')).not.toBeInTheDocument()
    expect(screen.queryByText(/loved this/)).not.toBeInTheDocument()
  })

  it('does not render a Share button', () => {
    renderDetail()
    expect(screen.queryByRole('button', { name: /Share/ })).not.toBeInTheDocument()
  })

  it('edits caption/album/favorite and PATCHes on Save', async () => {
    onUpdated.mockClear()
    renderDetail()

    // enter edit mode (there are two Edit affordances — topbar pill + card header)
    fireEvent.click(screen.getAllByRole('button', { name: /✏️ Edit/ })[0])

    const caption = screen.getByPlaceholderText('Caption') as HTMLInputElement
    fireEvent.change(caption, { target: { value: 'Sunset swim' } })
    // Album is now an AlbumPicker: choose "＋ New album…", then type a new name.
    const albumSelect = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(albumSelect, { target: { value: '__new__' } })
    const albumInput = screen.getByPlaceholderText('New album name') as HTMLInputElement
    fireEvent.change(albumInput, { target: { value: 'Beach Trip' } })
    fireEvent.click(screen.getByRole('button', { name: /Favorite/ }))

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(patched.length).toBe(1))
    expect(patched[0].id).toBe('ph1')
    expect(patched[0].patch).toMatchObject({
      caption: 'Sunset swim',
      memory: 'Beach Trip',
      isFavorite: true,
    })
    expect(onUpdated).toHaveBeenCalled()
  })

  it('selecting an existing album sends it as memory', async () => {
    renderDetail()
    fireEvent.click(screen.getAllByRole('button', { name: /✏️ Edit/ })[0])
    const albumSelect = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(albumSelect, { target: { value: 'Birthday' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(patched.length).toBe(1))
    expect(patched[0].patch).toMatchObject({ memory: 'Birthday' })
  })

  it('prefills the Date input from createdAt when takenAt is null', () => {
    render(
      <PhotoDetail
        photo={{ ...photo, takenAt: null }}
        memoryCount={2}
        albums={['Lake Day', 'Birthday']}
        onClose={() => {}}
        onSetScreensaver={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />
    )
    fireEvent.click(screen.getAllByRole('button', { name: /✏️ Edit/ })[0])
    const date = document.querySelector('input[type="date"]') as HTMLInputElement
    expect(date.value).not.toBe('')
  })

  it('Cancel exits edit mode without saving', () => {
    renderDetail()
    fireEvent.click(screen.getAllByRole('button', { name: /✏️ Edit/ })[0])
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(patched.length).toBe(0)
    expect(screen.queryByPlaceholderText('Caption')).not.toBeInTheDocument()
  })
})
