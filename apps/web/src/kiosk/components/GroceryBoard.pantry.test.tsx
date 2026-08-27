// The grocery board's "you already have this" badge.
//
// The rule these tests exist to hold: the badge FLAGS, it never FILTERS. Pantry matching
// is presence-only — it never compares quantities — so a matched row must stay on the
// list and stay checkable. "You have eggs" can be true while you have one egg and the
// recipe wants twelve, and hiding the row over that would be worse than the confusion the
// badge removes. So every test here asserts the row is still present.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { GroceryBoard } from './GroceryBoard'
import { TopbarSlotProvider } from '../topbar-slot'

const ok = (body: unknown) => ({ ok: true, json: async () => body })

const row = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  quantity: null,
  checked: false,
  checkedAt: null,
  section: null,
  sortOrder: 0,
  assignee: null,
  aisle: '',
  source: 'auto',
  sourceRecipeIds: [],
  addedBy: null,
  weekStart: '2026-06-07',
  pantry: null,
  ...extra,
})

function mockBoard(items: Array<Record<string, unknown>>) {
  const patched: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/lists/grocery/board')) {
      return ok({
        list: { id: 'g', name: 'Grocery', emoji: '🛒', listType: 'grocery', isAutoBuilt: true, sortMode: 'manual', itemCount: items.length },
        weekStart: '2026-06-07',
        meals: [],
        items,
        staples: [],
      })
    }
    if (u.includes('/api/list-items/') && opts?.method === 'PATCH') {
      patched.push({ url: u, body: JSON.parse(opts.body!) })
      return ok({ item: {} })
    }
    // The board self-rebuilds on first visit; let it succeed with the same payload.
    if (u.includes('/api/lists/grocery/rebuild')) return ok({ rebuilt: 0, board: null })
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return patched
}

const show = () =>
  render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <GroceryBoard onBack={() => {}} />
      </TopbarSlotProvider>
    </MemoryRouter>
  )

describe('GroceryBoard — pantry badge', () => {
  it('badges a row the pantry covers WITHOUT removing it from the list', async () => {
    mockBoard([row('Heavy cream', { pantry: { name: 'Heavy cream', amount: '2', unit: 'cups' } })])
    show()
    // Still shopping-visible — the whole point.
    expect(await screen.findByText('Heavy cream')).toBeInTheDocument()
    expect(screen.getByText(/2 cups/)).toBeInTheDocument()
  })

  it("shows the pantry item's own amount, making no claim about sufficiency", async () => {
    // "1 bag" against a recipe's "1½ lb" is not comparable, so we report and don't judge.
    mockBoard([row('Salmon fillets', { quantity: '1½ lb', pantry: { name: 'Salmon fillets', amount: '1', unit: 'bag' } })])
    show()
    await screen.findByText('Salmon fillets')
    expect(screen.getByText(/1 bag/)).toBeInTheDocument()
  })

  it('leads with the matched item name when the match was fuzzy', async () => {
    // "chicken" ↔ "chicken breast" matches; a bare "in pantry" would leave you guessing
    // what it found, and on a crowded row the tail is what gets ellipsized — so the
    // name (the half that can change your mind) goes first.
    mockBoard([row('Chicken', { pantry: { name: 'Chicken breast', amount: '3', unit: '' } })])
    show()
    await screen.findByText('Chicken')
    expect(screen.getByText(/Chicken breast · 3/)).toBeInTheDocument()
  })

  it('shows only the amount when the match is exact — the name adds nothing', async () => {
    mockBoard([row('Heavy cream', { pantry: { name: 'Heavy cream', amount: '2', unit: 'cups' } })])
    show()
    await screen.findByText('Heavy cream')
    const badge = screen.getByText(/2 cups/)
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).not.toMatch(/Heavy cream/)
  })

  it('says what the amount IS to a screen reader, not just a bare number', async () => {
    // Visually the 🥫 carries the meaning, but it is aria-hidden and `title` is not
    // announced on a span that already has text. So an exact match used to reach a screen
    // reader as a naked "2 cups" sitting right beside the row's OWN quantity — two
    // unlabeled numbers, no cue which belongs to the shelf. The badge has to name itself.
    mockBoard([row('Heavy cream', { quantity: '1 cup', pantry: { name: 'Heavy cream', amount: '2', unit: 'cups' } })])
    show()
    await screen.findByText('Heavy cream')
    const badge = document.querySelector('.gpantry')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toMatch(/in pantry/i)
    expect(badge!.textContent).toMatch(/2 cups/)
  })

  it('falls back to a bare label when the pantry item has no amount', async () => {
    mockBoard([row('Leeks', { pantry: { name: 'Leeks', amount: '', unit: '' } })])
    show()
    await screen.findByText('Leeks')
    expect(screen.getByText(/in pantry/)).toBeInTheDocument()
  })

  it('shows nothing on an unmatched row', async () => {
    mockBoard([row('Leeks')])
    show()
    await screen.findByText('Leeks')
    expect(screen.queryByText(/in pantry/)).not.toBeInTheDocument()
  })

  it('shows nothing when the server sends no pantry field at all (module off / older server)', async () => {
    const bare = row('Leeks')
    delete (bare as Record<string, unknown>).pantry
    mockBoard([bare])
    show()
    await screen.findByText('Leeks')
    expect(screen.queryByText(/in pantry/)).not.toBeInTheDocument()
  })

  it('leaves a badged row fully checkable — it is a nudge, not a lock', async () => {
    const patched = mockBoard([row('Heavy cream', { pantry: { name: 'Heavy cream', amount: '2', unit: 'cups' } })])
    show()
    fireEvent.click(await screen.findByText('Heavy cream'))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]!.body).toMatchObject({ checked: true })
  })
})
