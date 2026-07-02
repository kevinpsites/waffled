import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Photos } from './Photos'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// Render the topbar's right slot so the screen's "Play screensaver" / "Add
// photos" buttons (injected via useTopbarRight) are testable, the way KioskLayout
// wires them in the real app.
function TopbarRightSlot() {
  return <>{useTopbarSlots().right}</>
}

const beach = {
  id: 'ph1',
  imageUrl: null,
  caption: 'Beach day',
  emoji: '🏖️',
  colorHex: '#7fc1e8',
  memory: 'Lake Day',
  takenAt: '2026-05-31T15:00:00Z',
  isFavorite: true,
  reactions: {},
  uploadedBy: { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' },
  createdAt: '2026-05-31T15:00:00Z',
}

const cake = {
  ...beach,
  id: 'ph2',
  caption: 'Dad’s birthday',
  emoji: '🎂',
  colorHex: '#f6c24f',
  isFavorite: false,
  takenAt: '2026-05-31T18:00:00Z',
}

const soccer = {
  ...beach,
  id: 'ph3',
  caption: 'Soccer win',
  emoji: null,
  imageUrl: 'https://example.com/soccer.jpg',
  memory: null,
  colorHex: '#8fd3c4',
}

const DEFAULT_DISPLAY = { photoSource: 'all', photoAlbum: null, photoInterval: 10, photoShuffle: false }

function mockApi(opts: {
  photos?: unknown[]
  created?: unknown[]
  deleted?: string[]
  patched?: { id: string; body: Record<string, unknown> }[]
  display?: Record<string, unknown>
  displayPuts?: Record<string, unknown>[]
}) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (init?.method === 'POST' && /\/api\/photos$/.test(u)) {
      opts.created?.push(JSON.parse(init.body!))
      return { ok: true, status: 201, json: async () => ({ photo: { id: `new-${opts.created?.length}` } }) }
    }
    if (init?.method === 'PATCH' && /\/api\/photos\//.test(u)) {
      opts.patched?.push({ id: u.split('/').pop()!, body: JSON.parse(init.body!) })
      return { ok: true, json: async () => ({ photo: {} }) }
    }
    if (init?.method === 'DELETE') {
      opts.deleted?.push(u.split('/').pop()!)
      return { ok: true, status: 204, json: async () => ({}) }
    }
    if (/\/api\/kiosk\/display$/.test(u)) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body!)
        opts.displayPuts?.push(body)
        return { ok: true, json: async () => ({ ...DEFAULT_DISPLAY, ...opts.display, ...body }) }
      }
      return { ok: true, json: async () => ({ ...DEFAULT_DISPLAY, ...opts.display }) }
    }
    if (u.includes('/api/photos')) return { ok: true, json: async () => ({ photos: opts.photos ?? [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/photos']}>
      <TopbarSlotProvider>
        <TopbarRightSlot />
        <Photos />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('Photos home (family wall)', () => {
  it('renders the new-memory banner and the photo wall', async () => {
    mockApi({ photos: [beach, cake, soccer] })
    renderHome()

    // banner: memory name + count of photos in that memory (beach + cake = 2)
    expect(await screen.findByText(/“Lake Day” — 2 photos/)).toBeInTheDocument()
    expect(screen.getByText(/Recently added/i)).toBeInTheDocument()

    // wall tiles + captions
    expect(screen.getByText('Beach day')).toBeInTheDocument()
    expect(screen.getByText('Dad’s birthday')).toBeInTheDocument()
    // image-backed tile renders an <img>
    expect(screen.getByAltText('Soccer win')).toBeInTheDocument()
  })

  it('opens the photo detail with details (no reactions)', async () => {
    mockApi({ photos: [beach, cake] })
    renderHome()

    fireEvent.click(await screen.findByText('Beach day'))
    expect(await screen.findByText('Details')).toBeInTheDocument()
    // reactions card was removed
    expect(screen.queryByText('Reactions')).not.toBeInTheDocument()
    // Album row reflects the memory; Added by reflects uploader. "Lake Day" also
    // appears as a filter chip on the wall behind the overlay, so allow multiple.
    expect(screen.getAllByText('Lake Day').length).toBeGreaterThan(0)
    expect(screen.getByText('Kelly')).toBeInTheDocument()
    // album view CTA replaced the old "Part of …" AI box
    expect(screen.getByText(/View all .* in “Lake Day”/)).toBeInTheDocument()
  })

  it('sets a whole album as the screensaver source from the album action bar', async () => {
    const displayPuts: Record<string, unknown>[] = []
    mockApi({ photos: [beach, cake, soccer], displayPuts })
    renderHome()

    // no album action bar until an album is selected
    await screen.findByText('Beach day')
    expect(screen.queryByRole('button', { name: /Set as screensaver/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Lake Day$/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Set as screensaver/ }))

    await waitFor(() => expect(displayPuts).toHaveLength(1))
    expect(displayPuts[0]).toMatchObject({ photoSource: 'album', photoAlbum: 'Lake Day' })
    // the button now reflects the active state
    expect(await screen.findByRole('button', { name: /Screensaver album/ })).toBeInTheDocument()
  })

  it('Album row + CTA open the album view (filters the wall)', async () => {
    mockApi({ photos: [beach, cake, soccer] })
    renderHome()

    fireEvent.click(await screen.findByText('Beach day'))
    // the "View all … in Lake Day" CTA closes the detail and filters the wall
    fireEvent.click(await screen.findByText(/View all .* in “Lake Day”/))
    await waitFor(() => expect(screen.queryByText('Details')).not.toBeInTheDocument())
    // soccer (no album) is now hidden; the Lake Day chip is active
    expect(screen.queryByAltText('Soccer win')).not.toBeInTheDocument()
  })

  it('plays the full-screen screensaver and wakes on tap', async () => {
    mockApi({ photos: [beach, cake] })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /🖼️ Play/ }))
    // The full-screen screensaver is a heavy mount; on slow CI it can exceed findBy's
    // 1s default, so wait longer (resolves as soon as it appears).
    const saver = await screen.findByRole('button', { name: /Wake screensaver/ }, { timeout: 8000 })
    expect(within(saver).getByText('Tap anywhere to wake')).toBeInTheDocument()
    fireEvent.click(saver)
    await waitFor(() => expect(screen.queryByText('Tap anywhere to wake')).not.toBeInTheDocument())
  })

  it('opens the add overlay with the drag-and-drop upload zone', async () => {
    mockApi({ photos: [beach] })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Add photos/ }))
    // the add overlay's hero is the drag-and-drop / click-to-browse zone
    expect(await screen.findByText(/Drag & drop photos here/)).toBeInTheDocument()
    expect(screen.getByText(/click to browse/)).toBeInTheDocument()
  })

  it('filters the wall by album chip', async () => {
    mockApi({ photos: [beach, cake, soccer] })
    renderHome()

    // soccer has no album → hidden when "Lake Day" is selected
    await screen.findByText('Soccer win')
    fireEvent.click(screen.getByRole('button', { name: /^Lake Day$/ }))
    expect(screen.getByText('Beach day')).toBeInTheDocument()
    expect(screen.queryByAltText('Soccer win')).not.toBeInTheDocument()
    // back to All
    fireEvent.click(screen.getByRole('button', { name: /^All$/ }))
    expect(screen.getByAltText('Soccer win')).toBeInTheDocument()
  })

  it('confirms before deleting a single photo from the wall', async () => {
    const deleted: string[] = []
    mockApi({ photos: [beach, cake], deleted })
    renderHome()

    // tapping the tile's × opens a confirm dialog — it does NOT delete outright
    fireEvent.click(await screen.findByRole('button', { name: /Delete Beach day/ }))
    expect(await screen.findByText('Delete photo?')).toBeInTheDocument()
    expect(deleted).toHaveLength(0)

    // confirming deletes
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
    await waitFor(() => expect(deleted).toContain('ph1'))
  })

  it('cancels a delete without removing the photo', async () => {
    const deleted: string[] = []
    mockApi({ photos: [beach, cake], deleted })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Delete Beach day/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }))
    await waitFor(() => expect(screen.queryByText('Delete photo?')).not.toBeInTheDocument())
    expect(deleted).toHaveLength(0)
  })

  it('bulk-deletes selected photos after confirmation', async () => {
    const deleted: string[] = []
    mockApi({ photos: [beach, cake], deleted })
    renderHome()

    // enter select mode, pick both tiles
    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }))
    fireEvent.click(screen.getByText('Beach day'))
    fireEvent.click(screen.getByText('Dad’s birthday'))
    // the select-mode toolbar re-renders async on slow CI — wait for the count
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
    expect(await screen.findByText('Delete 2 photos?')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ }).pop()!)

    await waitFor(() => expect(deleted.sort()).toEqual(['ph1', 'ph2']))
  })

  it('moves selected photos to a chosen album', async () => {
    const patched: { id: string; body: Record<string, unknown> }[] = []
    mockApi({ photos: [beach, cake], patched })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }))
    fireEvent.click(screen.getByText('Beach day'))
    fireEvent.click(screen.getByText('Dad’s birthday'))
    fireEvent.click(await screen.findByRole('button', { name: /Move to album/ }))

    // pick a new album in the move modal, then Move
    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('New album name'), { target: { value: 'Summer 2026' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))

    await waitFor(() => expect(patched).toHaveLength(2))
    expect(patched.every((p) => p.body.memory === 'Summer 2026')).toBe(true)
    expect(patched.map((p) => p.id).sort()).toEqual(['ph1', 'ph2'])
  })
})
