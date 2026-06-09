import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Goals } from './Goals'

const personalGoal = {
  id: 'g1',
  title: 'Read 20 books',
  emoji: '📚',
  category: 'intellectual',
  goalType: 'count',
  unit: 'books',
  trackingMode: 'shared_total',
  deadline: null,
  isFeatured: false,
  target: 20,
  totalProgress: 5,
  participants: [{ personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 20, progress: 5 }],
}

const featuredGoal = {
  id: 'g2',
  title: '1,000 Hours Outside',
  emoji: '🌲',
  category: 'physical',
  goalType: 'total',
  unit: 'hours',
  trackingMode: 'shared_total',
  deadline: null,
  isFeatured: true,
  target: 1000,
  totalProgress: 312,
  participants: [
    { personId: 'p1', name: 'Wally', colorHex: '#25A368', avatarEmoji: '🐢', target: 1000, progress: 102 },
    { personId: 'p2', name: 'Kevin', colorHex: '#2F7FED', avatarEmoji: '🐻', target: 1000, progress: 78 },
  ],
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
  it('renders the featured hero with contributor bars and personal goals', async () => {
    mockApi({ goals: [featuredGoal, personalGoal] })
    render(<Goals />)

    // featured goal becomes the hero with its derived total + per-person contributions
    expect(await screen.findByText('1,000 Hours Outside')).toBeInTheDocument()
    expect(screen.getByText(/Featured/)).toBeInTheDocument()
    expect(screen.getByText('312')).toBeInTheDocument()

    // the single-owner goal shows in the personal column
    expect(screen.getByText('Read 20 books')).toBeInTheDocument()
    expect(screen.getByText(/Intellectual/)).toBeInTheDocument()
  })

  it('logs progress against a goal card', async () => {
    const logged: unknown[] = []
    mockApi({ goals: [personalGoal], logged })
    render(<Goals />)

    fireEvent.click(await screen.findByText('Read 20 books'))
    const modal = document.querySelector('.modal-card') as HTMLElement
    fireEvent.click(within(modal).getByRole('button', { name: 'Log it' }))
    await waitFor(() => expect(logged).toHaveLength(1))
    expect(logged[0]).toMatchObject({ amount: 1 })
  })

  it('shows the empty state', async () => {
    mockApi({ goals: [] })
    render(<Goals />)
    expect(await screen.findByText(/No goals yet/)).toBeInTheDocument()
  })
})
