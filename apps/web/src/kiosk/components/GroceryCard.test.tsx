import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GroceryCard } from './GroceryCard'

interface Item {
  id: string
  name: string
  quantity: string | null
  checked: boolean
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

// A stateful mock that routes GET/POST/PATCH like the real api.
function mockGrocery(initial: Array<Partial<Item>>) {
  let items: Item[] = initial.map((x, i) => ({ id: String(i + 1), quantity: null, checked: false, name: '', ...x }))
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = opts?.method ?? 'GET'
    if (u.endsWith('/api/lists/grocery') && method === 'GET') return ok({ items })
    if (u.endsWith('/api/lists/grocery/items') && method === 'POST') {
      const b = JSON.parse(opts!.body!)
      const it: Item = { id: 'n' + (items.length + 1), name: b.name, quantity: null, checked: false }
      items = [...items, it]
      return ok({ item: it })
    }
    if (u.includes('/api/list-items/') && method === 'PATCH') {
      const id = u.split('/').pop()
      const b = JSON.parse(opts!.body!)
      items = items.map((i) => (i.id === id ? { ...i, checked: b.checked } : i))
      return ok({ item: items.find((i) => i.id === id) })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('GroceryCard', () => {
  it('renders items from the api', async () => {
    mockGrocery([{ name: 'Milk' }, { name: 'Eggs' }])
    render(<GroceryCard />)
    expect(await screen.findByText('Milk')).toBeInTheDocument()
    expect(screen.getByText('Eggs')).toBeInTheDocument()
  })

  it('checks an item off (optimistic + PATCH)', async () => {
    mockGrocery([{ name: 'Milk' }])
    render(<GroceryCard />)
    const milk = await screen.findByText('Milk')
    fireEvent.click(milk)
    await waitFor(() => expect(milk).toHaveStyle('text-decoration: line-through'))
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls
    expect(calls.some(([u, o]) => String(u).includes('/api/list-items/') && o?.method === 'PATCH')).toBe(true)
  })

  it('adds an item via the input', async () => {
    mockGrocery([])
    render(<GroceryCard />)
    const input = await screen.findByLabelText('Add grocery item')
    fireEvent.change(input, { target: { value: 'Bread' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('Bread')).toBeInTheDocument()
  })
})
