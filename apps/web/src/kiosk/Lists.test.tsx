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
    if (/\/api\/lists\/[^/]+\/clear-completed$/.test(u) && method === 'POST') {
      return { ok: true, json: async () => ({ cleared: 1 }) }
    }
    if (u.endsWith('/api/lists') && method === 'POST') {
      return { ok: true, json: async () => ({ list: opts.created }) }
    }
    if (u.endsWith('/api/lists')) return { ok: true, json: async () => ({ lists: opts.lists ?? [] }) }
    // bulk edit (must precede the single-item PATCH regex, which captures "bulk" as :id)
    if (u.endsWith('/api/list-items/bulk') && method === 'PATCH') {
      return { ok: true, json: async () => ({ updated: (body?.ids?.length ?? 0) }) }
    }
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

    // header: name + "2 items · 1 done" (the count is active/unchecked only) + filter
    await waitFor(() => expect(screen.getByText('2 items · 1 done')).toBeInTheDocument())
    expect(screen.getByText('Everyone')).toBeInTheDocument()

    // suggestions
    expect(screen.getByText('Waffled suggests:')).toBeInTheDocument()
    expect(screen.getByText('Bug spray')).toBeInTheDocument()

    // active sectioned items render; the checked one is tucked into a collapsed
    // Completed section rather than lingering inline in its original section.
    // (Section names also appear as <option>s in the add-bar picker, so scope the
    // header-title queries to the section-name span.)
    expect(await screen.findByText('Clothes', { selector: '.lists-section-name' })).toBeInTheDocument()
    expect(screen.getByText('Gear', { selector: '.lists-section-name' })).toBeInTheDocument()
    expect(screen.getByText('Swimsuits')).toBeInTheDocument()
    expect(screen.getByText('×4')).toBeInTheDocument()
    expect(screen.queryByText('PJs & socks')).toBeNull()
    expect(screen.getByRole('button', { name: /Completed/i })).toHaveTextContent('1')
  })

  it('tucks checked items into a collapsible Completed section, out of their original section', async () => {
    mockApi({ lists: [grocery, packing], items: packItems })
    renderScreen()
    await exitBoard()

    // the checked item (PJs & socks, section Clothes) no longer sits in Clothes…
    const clothes = (await screen.findByText('Clothes', { selector: '.lists-section-name' })).closest('.lists-section') as HTMLElement
    expect(within(clothes).queryByText('PJs & socks')).toBeNull()
    expect(within(clothes).getByText('Swimsuits')).toBeInTheDocument()

    // …it's counted in a collapsed Completed section; expanding reveals it
    const completed = screen.getByRole('button', { name: /Completed/i })
    expect(completed).toHaveTextContent('1')
    fireEvent.click(completed)
    expect(await screen.findByText('PJs & socks')).toBeInTheDocument()
  })

  it('drags an item into another section and PATCHes its category', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    // Sunscreen lives in Gear; drag it onto the Clothes section
    const sunscreen = (await screen.findByText('Sunscreen')).closest('.litem') as HTMLElement
    const clothes = (await screen.findByText('Clothes', { selector: '.lists-section-name' })).closest('.lists-section') as HTMLElement
    fireEvent.dragStart(sunscreen)
    fireEvent.dragOver(clothes)
    fireEvent.drop(clothes)

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH' && /\/api\/list-items\/i3$/.test(s.url))).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH' && /\/api\/list-items\/i3$/.test(s.url))!
    expect(patch.body).toMatchObject({ category: 'Clothes' })
  })

  it('toggles an item via its checkbox and PATCHes checked state', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    // Only the checkbox toggles (not the row/name, which now opens the editor).
    fireEvent.click(await screen.findByRole('button', { name: 'Check Swimsuits' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH' && /\/api\/list-items\/i1$/.test(s.url))).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH' && /\/api\/list-items\/i1$/.test(s.url))!
    expect(patch.body).toMatchObject({ checked: true })
  })

  it('opens the item editor when the item name is tapped (not a toggle)', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Swimsuits' }))
    // the edit modal opens…
    expect(await screen.findByText('Edit item')).toBeInTheDocument()
    // …and tapping the name did NOT toggle the item
    expect(sent.some((s) => s.method === 'PATCH' && /\/api\/list-items\//.test(s.url))).toBe(false)
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

    // packing is auto-selected in the hub; "Save as template" lives in the ⋯ menu
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }))
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

    // its header offers "Use template" (not "Save as template") — it opens the
    // create modal pre-pointed at the template (name prefilled); submitting applies it
    fireEvent.click(await screen.findByRole('button', { name: /Use template/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Create from template/i }))
    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && /\/api\/lists\/templates\/tpl\/apply$/.test(s.url))).toBe(true))
  })

  it('moves a template back to lists from its header action', async () => {
    const sent: Sent[] = []
    const template = { id: 'tpl', name: 'Beach Day', emoji: '🏖️', listType: 'template', isAutoBuilt: false, sortMode: 'manual', itemCount: 4 }
    mockApi({ lists: [grocery, packing], items: packItems, sent, templates: [template] })
    renderScreen()
    await exitBoard()

    fireEvent.click(await screen.findByRole('button', { name: /Beach Day/ }))
    // "Move to Lists" lives in the ⋯ menu for a template
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }))
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

  it('collapses a section when its header toggle is clicked', async () => {
    mockApi({ lists: [grocery, packing], items: packItems })
    renderScreen()
    await exitBoard()

    // Swimsuits shows under the Clothes section…
    expect(await screen.findByText('Swimsuits')).toBeInTheDocument()
    // …click the Clothes section header to collapse it → its items hide
    const header = screen.getByText('Clothes', { selector: '.lists-section-name' }).closest('button') as HTMLElement
    fireEvent.click(header)
    await waitFor(() => expect(screen.queryByText('Swimsuits')).toBeNull())
  })

  it('bulk-edits selected items via the Select toolbar (PATCH /api/list-items/bulk)', async () => {
    const sent: Sent[] = []
    mockApi({ lists: [grocery, packing], items: packItems, sent })
    renderScreen()
    await exitBoard()
    await screen.findByText('Swimsuits')

    // enter multi-select, pick Swimsuits, then STAGE a section change
    fireEvent.click(screen.getByRole('button', { name: /Select/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Select Swimsuits' }))
    fireEvent.change(screen.getByLabelText('Set section for selected'), { target: { value: 'Gear' } })

    // staging must NOT write yet — the change only commits on Done
    expect(sent.some((s) => s.method === 'PATCH' && s.url.endsWith('/api/list-items/bulk'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH' && s.url.endsWith('/api/list-items/bulk'))).toBe(true))
    const patch = sent.find((s) => s.method === 'PATCH' && s.url.endsWith('/api/list-items/bulk'))!
    // only the staged field is sent — untouched assignee/priority are left alone
    expect(patch.body).toEqual({ ids: ['i1'], patch: { section: 'Gear' } })
  })

  it('flattens into a highest-priority-first view when "By priority" is toggled on', async () => {
    const items = [
      { id: 'a', name: 'Low item', quantity: null, checked: false, checkedAt: null, section: 'Clothes', sortOrder: 0, assignee: null, priority: 2 },
      { id: 'b', name: 'Urgent item', quantity: null, checked: false, checkedAt: null, section: 'Gear', sortOrder: 1, assignee: null, priority: 5 },
      { id: 'c', name: 'Normal item', quantity: null, checked: false, checkedAt: null, section: 'Clothes', sortOrder: 2, assignee: null, priority: 3 },
    ]
    mockApi({ lists: [grocery, packing], items })
    const { container } = renderScreen()
    await exitBoard()
    await screen.findByText('Urgent item')

    // default (manual) view keeps the section grouping — no priority reordering
    // (query the section-title span, since 'Clothes' also appears as an add-bar option)
    expect(screen.getByText('Clothes', { selector: '.lists-section-name' })).toBeInTheDocument()

    // toggle on → flat, highest-priority first, section titles gone
    fireEvent.click(screen.getByRole('button', { name: /Sort: manual/i }))
    await waitFor(() => expect(screen.queryByText('Clothes', { selector: '.lists-section-name' })).not.toBeInTheDocument())
    const titles = [...container.querySelectorAll('.lists-section-title')].map((el) => el.textContent)
    expect(titles).toEqual(['By priority'])

    const rows = [...container.querySelectorAll('.litem')].map((el) => el.textContent ?? '')
    const idx = (name: string) => rows.findIndex((t) => t.includes(name))
    expect(idx('Urgent item')).toBeLessThan(idx('Normal item'))
    expect(idx('Normal item')).toBeLessThan(idx('Low item'))
  })
})
