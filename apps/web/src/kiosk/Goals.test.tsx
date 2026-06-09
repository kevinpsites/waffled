import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Goals } from './Goals'

const sampleGoal = {
  id: 'g1',
  title: 'Read 20 books',
  emoji: '📚',
  category: 'intellectual',
  goalType: 'count',
  unit: 'books',
  trackingMode: 'shared_total',
  deadline: null,
  target: 20,
  totalProgress: 5,
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 20, progress: 5 }],
}

function mockApi(opts: { goals?: unknown[]; logged?: unknown[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (u.endsWith('/api/goals') && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => ({ goals: opts.goals ?? [] }) }
    }
    if (/\/api\/goals\/[^/]+\/log$/.test(u) && init?.method === 'POST') {
      opts.logged?.push(JSON.parse(init.body!))
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Goals screen', () => {
  it('renders goals with progress and logs against one', async () => {
    const logged: unknown[] = []
    mockApi({ goals: [sampleGoal], logged })
    render(<Goals />)

    expect(await screen.findByText('Read 20 books')).toBeInTheDocument()
    expect(screen.getByText(/Intellectual/)).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()

    // open the Log modal and submit
    fireEvent.click(screen.getByRole('button', { name: /Log/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log it' }))
    await waitFor(() => expect(logged).toHaveLength(1))
    expect(logged[0]).toMatchObject({ amount: 1 })
  })

  it('shows the empty state', async () => {
    mockApi({ goals: [] })
    render(<Goals />)
    expect(await screen.findByText(/No goals yet/)).toBeInTheDocument()
  })
})
