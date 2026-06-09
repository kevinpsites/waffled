import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Tasks } from './Tasks'

interface Inst {
  id: string
  choreTitle: string
  emoji: string | null
  personId: string
  personName: string
  status: string
  rewardAmount: number
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

function mockInstances(initial: Inst[]) {
  let instances = [...initial]
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
    const u = String(url)
    const m = opts?.method ?? 'GET'
    if (u.includes('/api/chore-instances/today') && m === 'GET') return ok({ date: 'x', instances })
    if (u.includes('/complete') && m === 'POST') {
      const id = u.split('/').slice(-2)[0]
      instances = instances.map((i) => (i.id === id ? { ...i, status: 'done' } : i))
      return ok({ instance: { id, status: 'done' } })
    }
    if (u.includes('/uncomplete') && m === 'POST') {
      const id = u.split('/').slice(-2)[0]
      instances = instances.map((i) => (i.id === id ? { ...i, status: 'pending' } : i))
      return ok({ instance: { id, status: 'pending' } })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Tasks screen', () => {
  it('lists chores grouped by person and completes one', async () => {
    mockInstances([
      { id: '1', choreTitle: 'Feed dog', emoji: '🐶', personId: 'p1', personName: 'Wally', status: 'pending', rewardAmount: 2 },
      { id: '2', choreTitle: 'Set table', emoji: '🍽️', personId: 'p2', personName: 'Lottie', status: 'pending', rewardAmount: 2 },
    ])
    render(<Tasks />)
    expect(await screen.findByText(/Feed dog/)).toBeInTheDocument()
    expect(screen.getByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Complete Feed dog/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Uncomplete Feed dog/ })).toBeInTheDocument()
    )
  })
})
