import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ListCard, TODAY_LIST_PICK_KEY } from './ListCard'
import type { ListItem, ListSummary } from '../../lib/api'

// The Today "Lists" card pins ONE of the household's lists, chosen on the card
// itself — the same shape as the Goals card's pinned goal, and stored per device
// for the same reason (it's a viewing preference, not household config).
// Hoisted: vi.mock's factory runs before module-level consts are initialized.
const { listsRef, itemsRef, setItemChecked, detailFor } = vi.hoisted(() => ({
  listsRef: { current: [] as ListSummary[] },
  itemsRef: { current: [] as ListItem[] },
  setItemChecked: vi.fn(async () => {}),
  detailFor: { current: null as string | null },
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    useLists: () => ({ lists: listsRef.current, loading: false, error: false, refetch: () => {} }),
    useListDetail: (id: string | null) => {
      detailFor.current = id
      return { items: itemsRef.current, loading: false, error: false, setItems: () => {}, refetch: () => {} }
    },
    groceryApi: { ...actual.groceryApi, setItemChecked },
  }
})

const list = (id: string, name: string, over: Partial<ListSummary> = {}): ListSummary => ({
  id, name, emoji: null, listType: 'custom', isAutoBuilt: false, sortMode: 'manual', itemCount: 0, ...over,
})

const item = (id: string, name: string, checked = false): ListItem =>
  ({ id, name, quantity: null, checked, section: null, aisle: null, store: null, priority: null, assignee: null } as unknown as ListItem)

beforeEach(() => {
  localStorage.clear()
  setItemChecked.mockClear()
  detailFor.current = null
  listsRef.current = [list('l1', 'Hardware store'), list('l2', 'Packing')]
  itemsRef.current = [item('i1', 'Wood screws'), item('i2', 'Sandpaper'), item('i3', 'Wood glue', true)]
})

describe('ListCard (Today)', () => {
  it('pins the first list when nothing has been chosen yet', () => {
    render(<ListCard />)
    expect(detailFor.current).toBe('l1')
    // The card is titled by the pinned list (the picker's <option> also carries
    // the name, so scope this to the heading).
    expect(document.querySelector('.card-h')?.textContent).toBe('Hardware store')
  })

  it('shows the pinned list’s unfinished items and leaves the done ones out', () => {
    render(<ListCard />)
    expect(screen.getByText('Wood screws')).toBeInTheDocument()
    expect(screen.getByText('Sandpaper')).toBeInTheDocument()
    expect(screen.queryByText('Wood glue')).not.toBeInTheDocument()
  })

  it('switches lists from the card and remembers the choice for this device', async () => {
    render(<ListCard />)
    fireEvent.change(screen.getByLabelText(/which list/i), { target: { value: 'l2' } })
    await waitFor(() => expect(detailFor.current).toBe('l2'))
    expect(localStorage.getItem(TODAY_LIST_PICK_KEY)).toBe('l2')
  })

  it('restores the remembered list on the next render', () => {
    localStorage.setItem(TODAY_LIST_PICK_KEY, 'l2')
    render(<ListCard />)
    expect(detailFor.current).toBe('l2')
  })

  // A pinned list that has since been deleted must not leave the card blank and
  // stuck — fall back to whatever the household still has.
  it('falls back to the first list when the pinned one is gone', () => {
    localStorage.setItem(TODAY_LIST_PICK_KEY, 'deleted-list')
    render(<ListCard />)
    expect(detailFor.current).toBe('l1')
  })

  it('checks an item off from the card', async () => {
    render(<ListCard />)
    fireEvent.click(screen.getByRole('button', { name: /Wood screws/ }))
    await waitFor(() => expect(setItemChecked).toHaveBeenCalledWith('i1', true))
  })

  it('says so when the pinned list is all done', () => {
    itemsRef.current = [item('i3', 'Wood glue', true)]
    render(<ListCard />)
    expect(screen.getByText(/all done/i)).toBeInTheDocument()
  })

  // The grocery board has its own Today card; offering it here too would be two
  // cards fighting over the same list.
  it('never offers the auto-built grocery list', () => {
    listsRef.current = [list('g', 'Grocery', { listType: 'grocery', isAutoBuilt: true }), list('l1', 'Hardware store')]
    render(<ListCard />)
    expect(detailFor.current).toBe('l1')
    expect(screen.queryByRole('option', { name: 'Grocery' })).not.toBeInTheDocument()
  })

  it('prompts to make a list when the household has none', () => {
    listsRef.current = []
    render(<ListCard />)
    expect(screen.getByText(/no lists yet/i)).toBeInTheDocument()
  })
})
