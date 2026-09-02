import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider, useTopbarSlots } from '../topbar-slot'

function TopbarProbe() {
  return <>{useTopbarSlots().full}</>
}

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  quantity: null,
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 0,
  assignee: null,
  aisle: '',
  source: 'manual',
  sourceRecipeIds: [],
  addedBy: null,
  store: null,
  ...extra,
})

const items = [
  row('i1', 'Tomatoes', { aisle: 'Produce', quantity: '2' }),
  row('i2', 'Kale', { aisle: 'Produce' }),
  row('i3', 'Milk', { aisle: 'Dairy & Chilled', store: 'Costco' }),
  row('i4', 'Toothpaste', { checked: true, checkedAt: '2026-06-07T00:00:00Z' }),
  row('i5', 'Sponges', { checked: true, checkedAt: '2026-06-07T00:00:00Z' }),
]

const ok = (body: unknown) => ({ ok: true, json: async () => body })

function mockBoard() {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/lists/grocery/board')) {
      return ok({
        list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: 4 },
        weekStart: '2026-06-07',
        meals: [],
        items,
        staples: [],
      })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderBoard() {
  return render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <TopbarProbe />
        <GroceryBoard onBack={() => {}} />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('GroceryBoard search', () => {
  it('filters rows by name, aisle and store as you type, and clears back', async () => {
    mockBoard()
    renderBoard()
    await screen.findByText('Tomatoes')

    const box = screen.getByLabelText('Search this list')
    fireEvent.change(box, { target: { value: 'kale' } })
    await waitFor(() => expect(screen.queryByText('Tomatoes')).toBeNull())
    expect(screen.getByText('Kale')).toBeInTheDocument()

    // the aisle a row sits under is searchable, so "produce" keeps both of them
    fireEvent.change(box, { target: { value: 'produce' } })
    await waitFor(() => expect(screen.getByText('Tomatoes')).toBeInTheDocument())
    expect(screen.getByText('Kale')).toBeInTheDocument()
    expect(screen.queryByText('Milk')).toBeNull()

    // so is the store it's tagged with
    fireEvent.change(box, { target: { value: 'costco' } })
    await waitFor(() => expect(screen.getByText('Milk')).toBeInTheDocument())
    expect(screen.queryByText('Kale')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(screen.getByText('Tomatoes')).toBeInTheDocument())
  })

  it('surfaces a match hiding in a collapsed aisle, and restores the collapse when cleared', async () => {
    mockBoard()
    renderBoard()
    await screen.findByText('Tomatoes')

    // collapse Produce the way a shopper who's done that aisle would
    fireEvent.click(screen.getByText('Produce'))
    await waitFor(() => expect(screen.queryByText('Tomatoes')).toBeNull())

    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'tomato' } })
    await waitFor(() => expect(screen.getByText('Tomatoes')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(screen.queryByText('Tomatoes')).toBeNull())
  })

  it('finds a checked item without opening Completed first', async () => {
    mockBoard()
    renderBoard()
    await screen.findByText('Tomatoes')
    expect(screen.queryByText('Toothpaste')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'tooth' } })
    await waitFor(() => expect(screen.getByText('Toothpaste')).toBeInTheDocument())
  })

  it('counts the whole Completed group, since Clear sweeps all of it', async () => {
    mockBoard()
    renderBoard()
    await screen.findByText('Tomatoes')

    // two checked rows; searching down to one must not make Clear look like it
    // will delete one — it deletes every checked row on the board
    const done = () => screen.getByText('Completed').closest('.grocery-done-h') as HTMLElement
    expect(done()).toHaveTextContent('2')

    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'tooth' } })
    await waitFor(() => expect(screen.getByText('Toothpaste')).toBeInTheDocument())
    expect(screen.queryByText('Sponges')).toBeNull()
    expect(done()).toHaveTextContent('2')
  })

  it('says nothing matched when the search comes up empty', async () => {
    mockBoard()
    renderBoard()
    await screen.findByText('Tomatoes')

    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'kayak' } })
    await waitFor(() => expect(screen.getByText(/No items match/i)).toBeInTheDocument())
  })
})
