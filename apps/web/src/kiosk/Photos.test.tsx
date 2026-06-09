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

function mockApi(opts: { photos?: unknown[]; created?: unknown[]; deleted?: string[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (init?.method === 'POST' && /\/api\/photos$/.test(u)) {
      opts.created?.push(JSON.parse(init.body!))
      return { ok: true, status: 201, json: async () => ({ photo: { id: `new-${opts.created?.length}` } }) }
    }
    if (init?.method === 'DELETE') {
      opts.deleted?.push(u.split('/').pop()!)
      return { ok: true, status: 204, json: async () => ({}) }
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
    expect(screen.getByText(/New memory/i)).toBeInTheDocument()

    // wall tiles + captions
    expect(screen.getByText('Beach day')).toBeInTheDocument()
    expect(screen.getByText('Dad’s birthday')).toBeInTheDocument()
    // image-backed tile renders an <img>
    expect(screen.getByAltText('Soccer win')).toBeInTheDocument()
  })

  it('opens the photo detail with reactions and details', async () => {
    mockApi({ photos: [beach, cake] })
    renderHome()

    fireEvent.click(await screen.findByText('Beach day'))
    expect(await screen.findByText('Reactions')).toBeInTheDocument()
    expect(screen.getByText('Details')).toBeInTheDocument()
    // Album row reflects the memory; Added by reflects uploader
    expect(screen.getByText('Lake Day')).toBeInTheDocument()
    expect(screen.getByText('Kelly')).toBeInTheDocument()
    expect(screen.getByText(/Part of “Lake Day”/)).toBeInTheDocument()
  })

  it('plays the full-screen screensaver and wakes on tap', async () => {
    mockApi({ photos: [beach, cake] })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Play screensaver/ }))
    const saver = await screen.findByRole('button', { name: /Wake screensaver/ })
    expect(within(saver).getByText('Tap anywhere to wake')).toBeInTheDocument()
    fireEvent.click(saver)
    await waitFor(() => expect(screen.queryByText('Tap anywhere to wake')).not.toBeInTheDocument())
  })

  it('adds selected candidate photos through the add overlay', async () => {
    const created: unknown[] = []
    mockApi({ photos: [beach], created })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Add photos/ }))
    // pick two candidate tiles
    const tiles = document.querySelectorAll('.ap-tile')
    fireEvent.click(tiles[0])
    fireEvent.click(tiles[1])
    // the add button counts the selection
    fireEvent.click(screen.getByRole('button', { name: /Add\s*2\s*photos/ }))
    await waitFor(() => expect(created).toHaveLength(2))
    expect(created[0]).toMatchObject({ memory: 'Lake Day' })
  })

  it('deletes a photo from the wall', async () => {
    const deleted: string[] = []
    mockApi({ photos: [beach, cake], deleted })
    renderHome()

    fireEvent.click(await screen.findByRole('button', { name: /Delete Beach day/ }))
    await waitFor(() => expect(deleted).toContain('ph1'))
  })
})
