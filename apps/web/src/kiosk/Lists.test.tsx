import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Lists } from './Lists'
import { ListsModal } from './components/ListsModal'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

const grocery = { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 15 }
const packing = { id: 'pack', name: 'Lake trip packing', emoji: '🧳', listType: 'custom', isAutoBuilt: false, sortMode: 'manual', itemCount: 3 }

const kelly = { personId: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' }

const packItems = [
  { id: 'i1', name: 'Swimsuits', quantity: '×4', checked: false, checkedAt: null, section: 'Clothes', sortOrder: 0, assignee: kelly },
  { id: 'i2', name: 'PJs & socks', quantity: null, checked: true, checkedAt: '2026-05-31T00:00:00Z', section: 'Clothes', sortOrder: 1, assignee: null },
  { id: 'i3', name: 'Sunscreen', quantity: null, checked: false, checkedAt: null, section: 'Gear', sortOrder: 0, assignee: null },
]

const persons = [
  { id: 'p1', name: 'Kevin', avatarEmoji: '🐻', colorHex: '#2F7FED' },
  { id: 'p2', name: 'Kelly', avatarEmoji: '🦊', colorHex: '#EC6049' },
]

interface Sent {
  method: string
  url: string
  body: unknown
}

function mockApi(opts: { lists?: unknown[]; items?: unknown[]; sent?: Sent[]; created?: unknown; templates?: unknown[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    opts.sent?.push({ method, url: u, body })
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons }) }
    // list templates GET (must precede the list-detail regex, which would else
    // capture "templates" as an :id)
    if (u.endsWith('/api/lists/templates') && method === 'GET') {
      return { ok: true, json: async () => ({ templates: opts.templates ?? [] }) }
    }
    // list detail (must precede the bare /api/lists check)
    if (/\/api\/lists\/[^/]+$/.test(u) && method === 'GET') {
      return { ok: true, json: async () => ({ list: packing, items: opts.items ?? [] }) }
    }
    if (/\/api\/lists\/[^/]+\/items$/.test(u) && method === 'POST') {
      return { ok: true, json: async () => ({ item: { id: 'new', name: body.name, quantity: null, checked: false, checkedAt: null, section: null, sortOrder: 99, assignee: null } }) }
    }
    // grocery board (auto-built view) — must precede the bare /api/lists check
    if (u.includes('/api/lists/grocery/board')) {
      return { ok: true, json: async () => ({ list: grocery, weekStart: '2026-06-07', meals: [], items: [], staples: [] }) }
    }
    // list templates (must precede the bare /api/lists checks)
    if (/\/api\/lists\/[^/]+\/save-as-template$/.test(u) && method === 'POST') {
      return { ok: true, json: async () => ({ template: { ...packing, listType: 'template' } }) }
    }
    if (/\/api\/lists\/[^/]+\/unmark-template$/.test(u) && method === 'POST') {
      return { ok: true, json: async () => ({ list: { ...packing, listType: 'custom' } }) }
    }
    if (/\/api\/lists\/templates\/[^/]+\/apply$/.test(u) && method === 'POST') {
      return { ok: true, json: async () => ({ list: { ...packing, id: 'applied', name: body?.name ?? 'Applied', listType: 'custom' } }) }
    }
    if (u.endsWith('/api/lists') && method === 'POST') {
      return { ok: true, json: async () => ({ list: opts.created }) }
    }
    if (u.endsWith('/api/lists')) return { ok: true, json: async () => ({ lists: opts.lists ?? [] }) }
    if (/\/api\/list-items\/[^/]+$/.test(u) && method === 'PATCH') {
      return { ok: true, json: async () => ({ item: { id: u.split('/').pop(), name: 'Swimsuits', quantity: '×4', checked: body.checked ?? false, checkedAt: null, section: 'Clothes', sortOrder: 0, assignee: body.assignedTo === null ? null : kelly } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

// Renders whatever the active screen pushes into the topbar slot, so the grocery
// board's "‹ Lists" back button is clickable from tests.
function Slots() {
  const { right, full } = useTopbarSlots()
  return <div>{full}{right}</div>
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/lists']}>
      <TopbarSlotProvider>
        <Slots />
        <Lists />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

// The grocery list auto-opens its board on load; the hub tests below first return
// to the lists hub to exercise custom-list behavior.
async function exitBoard() {
  fireEvent.click(await screen.findByRole('button', { name: '‹ Lists' }))
}

describe('Lists screen', () => {
  it('renders the sidebar, header, summary, suggestions, and sectioned items', async () => {
    mockApi({ lists: [grocery, packing], items: packItems })
    renderScreen()
    await exitBoard()

    // back in the hub, the only non-grocery list (packing) is auto-selected;
    // sidebar shows both lists with grocery's ✦ auto count
    expect(await screen.findByText('Grocery')).toBeInTheDocument()
    expect(screen.getByText('✦ 15')).toBeInTheDocument()
    expect(screen.getAllByText('Lake trip packing').length).toBeGreaterThan(0)

    // header: name + "3 items · 1 packed" + filter
    await waitFor(() => expect(screen.getByText('3 items · 1 packed')).toBeInTheDocument())
    expect(screen.getByText('Everyone')).toBeInTheDocument()

    // suggestions
    expect(screen.getByText('Waffled suggests:')).toBeInTheDocument()
    expect(screen.getByText('Bug spray')).toBeInTheDocument()

    // sectioned items with strikethrough on the checked one (titles uppercased via CSS)
    expect(await screen.findByText('Clothes')).toBeInTheDocument()
    expect(screen.getByText('Gear')).toBeInTheDocument()
    expect(screen.getByText('Swimsuits')).toBeInTheDocument()
    expect(screen.getByText('×4')).toBeInTheDocument()
    const pjs = screen.getByText('PJs & socks').closest('.litem')!
    expect(pjs).toHaveClass('done')
  })

  it('toggles an item and PATCHes checked state', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    fireEvent.click(await screen.findByText('Swimsuits'))
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH' && /\/api\/list-items\/i1$/.test(s.url))).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH' && /\/api\/list-items\/i1$/.test(s.url))!
    expect(patch.body).toMatchObject({ checked: true })
  })

  it('assigns an item to a person via the avatar menu', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    // Sunscreen has no assignee → its "+" assign button opens the menu
    const sunscreen = (await screen.findByText('Sunscreen')).closest('.litem') as HTMLElement
    fireEvent.click(within(sunscreen).getByRole('button', { name: 'Assign' }))
    fireEvent.click(await screen.findByRole('button', { name: /Kevin/ }))

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH')!
    expect(patch.body).toMatchObject({ assignedTo: 'p1' })
  })

  it('adds an item from a suggestion chip', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    fireEvent.click(await screen.findByText('Bug spray'))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/items$/.test(s.url))).toBe(true))
    const post = sent.find((s) => s.method === 'POST' && /\/items$/.test(s.url))!
    expect(post.body).toMatchObject({ name: 'Bug spray' })
  })

  it('adds a typed item from the add bar', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    const input = await screen.findByLabelText('Add to this list')
    fireEvent.change(input, { target: { value: 'Water bottles' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/items$/.test(s.url))).toBe(true))
    expect(sent.find((s) => s.method === 'POST' && /\/items$/.test(s.url))!.body).toMatchObject({ name: 'Water bottles' })
  })

  // The "New list" trigger lives in the shared topbar slot (wired by KioskLayout,
  // out of this screen's scope), so the modal itself is exercised directly.
  it('creates a list from the New list modal', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent, created: { ...packing, id: 'new', name: 'Costco' } })
    const onCreated = vi.fn()
    render(<ListsModal onClose={() => {}} onCreated={onCreated} />)

    fireEvent.change(screen.getByPlaceholderText('Lake trip packing'), { target: { value: 'Costco' } })
    fireEvent.click(screen.getByRole('button', { name: /Create list/ }))

    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/api/lists'))).toBe(true))
    expect(sent.find((s) => s.method === 'POST' && s.url.endsWith('/api/lists'))!.body).toMatchObject({ name: 'Costco' })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new'))
  })

  it('saves the selected list as a template from the header action', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    // packing is auto-selected in the hub; its header exposes a "Save as template" action
    fireEvent.click(await screen.findByRole('button', { name: /Save as template/i }))

    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/save-as-template$/.test(s.url))).toBe(true))
    const post = sent.find((s) => s.method === 'POST' && /\/save-as-template$/.test(s.url))!
    expect(post.url).toContain('/api/lists/pack/save-as-template')
  })

  it('shows a Templates section and uses one from its header action', async () => {
    const sent: Sent[] = []
    const template = { id: 'tpl', name: 'Beach Day', emoji: '🏖️', listType: 'template', isAutoBuilt: false, sortMode: 'manual', itemCount: 4 }
    mockApi({ lists: [grocery, packing], items: packItems, sent, templates: [template] })
    renderScreen()
    await exitBoard()

    // templates get their own rail group; select the template from it
    expect(await screen.findByText('TEMPLATES')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Beach Day/ }))

    // its header offers "Use template" (not "Save as template") — apply spins up a list
    fireEvent.click(await screen.findByRole('button', { name: /Use template/i }))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/lists\/templates\/tpl\/apply$/.test(s.url))).toBe(true))
  })

  it('moves a template back to lists from its header action', async () => {
    const sent: Sent[] = []
    const template = { id: 'tpl', name: 'Beach Day', emoji: '🏖️', listType: 'template', isAutoBuilt: false, sortMode: 'manual', itemCount: 4 }
    mockApi({ lists: [grocery, packing], items: packItems, sent, templates: [template] })
    renderScreen()
    await exitBoard()

    fireEvent.click(await screen.findByRole('button', { name: /Beach Day/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Move to Lists/i }))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/lists\/tpl\/unmark-template$/.test(s.url))).toBe(true))
  })

  it('applies a template from the New list modal picker', async () => {
    const sent: Sent[] = []
    const template = { id: 'tpl', name: 'Beach Day', emoji: '🏖️', listType: 'template', isAutoBuilt: false, sortMode: 'manual', itemCount: 4 }
    mockApi({ lists: [grocery, packing], items: packItems, sent, templates: [template] })
    const onCreated = vi.fn()
    render(<ListsModal onClose={() => {}} onCreated={onCreated} />)

    // the saved template is offered as an "apply" option
    fireEvent.click(await screen.findByRole('button', { name: /Beach Day/ }))

    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/lists\/templates\/tpl\/apply$/.test(s.url))).toBe(true))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('applied'))
  })
})
