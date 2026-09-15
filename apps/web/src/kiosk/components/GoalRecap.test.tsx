import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GoalRecapBar } from './GoalRecap'

const thaw = {
  eventId: 'e1',
  title: '🧊 Thaw for Dinner · Garlic Chicken',
  startsAt: '2026-09-14T15:00:00Z',
  allDay: false,
  goalId: 'g1',
  goalTitle: 'Host 30 families',
  goalEmoji: '🏡',
  via: 'llm',
  ignoreWords: ['thaw', 'dinner', 'garlic', 'chicken'],
}

function mockApi(suggestions: unknown[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (u.includes('/api/goal-calendar/suggestions/ignore')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (u.includes('/api/goal-calendar/suggestions')) return { ok: true, status: 200, json: async () => ({ items: suggestions }) }
    if (u.includes('/api/goal-calendar/recap')) return { ok: true, status: 200, json: async () => ({ items: [] }) }
    if (u.includes('/api/persons')) return { ok: true, status: 200, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return calls
}

describe('Review drawer — ignoring words for a goal', () => {
  it('picks words from the event title and ignores them for that goal', async () => {
    const calls = mockApi([thaw])
    render(<GoalRecapBar />)
    fireEvent.click(await screen.findByRole('button', { name: /might count toward a goal/i }))

    fireEvent.click(screen.getByRole('button', { name: 'Ignore…' }))
    expect(screen.getByText(/Stop suggesting events with these words for Host 30 families/)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Ignore for this goal' })
    expect(confirm).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'thaw' }))
    expect(screen.getByRole('button', { name: 'thaw' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(confirm)

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/suggestions/ignore'))
      expect(post?.method).toBe('POST')
      expect(post?.body).toEqual({ goalId: 'g1', words: ['thaw'] })
    })
    // The queue reloads so the ignored suggestion drops away.
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/api/goal-calendar/suggestions')).length).toBeGreaterThan(1))
  })
})
