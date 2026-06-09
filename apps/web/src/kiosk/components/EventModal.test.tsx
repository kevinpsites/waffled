import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventModal } from './EventModal'

describe('EventModal', () => {
  it('creates an event with the entered details', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      if (String(url).includes('/api/persons')) {
        return { ok: true, json: async () => ({ persons: [] }) }
      }
      if (String(url).includes('/api/events') && opts?.method === 'POST') {
        calls.push({ url: String(url), body: JSON.parse(opts.body!) })
        return { ok: true, json: async () => ({ event: { id: 'e1' } }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<EventModal date="2026-06-09" onClose={onClose} onCreated={onCreated} />)

    fireEvent.change(screen.getByPlaceholderText('Soccer practice'), { target: { value: 'Dentist' } })
    fireEvent.click(screen.getByRole('button', { name: /Add event/ }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toMatchObject({ title: 'Dentist', allDay: false })
    expect(typeof calls[0].body.startsAt).toBe('string')
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })
})
