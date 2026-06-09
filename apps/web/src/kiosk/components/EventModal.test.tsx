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
    const onSaved = vi.fn()
    render(<EventModal date="2026-06-09" onClose={onClose} onSaved={onSaved} />)

    fireEvent.change(screen.getByPlaceholderText('Soccer practice'), { target: { value: 'Dentist' } })
    fireEvent.click(screen.getByRole('button', { name: /Add event/ }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body).toMatchObject({ title: 'Dentist', allDay: false })
    expect(typeof calls[0].body.startsAt).toBe('string')
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  const sampleEvent = {
    id: 'e1',
    title: 'Old title',
    startsAt: '2026-06-09T22:00:00Z',
    endsAt: null,
    allDay: false,
    location: null,
    personId: null,
    personName: null,
    personColor: null,
    personEmoji: null,
    participants: [],
  }

  function mockEventApi(patched: unknown[], deleted: string[]) {
    globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
      if (/\/api\/events\/[^/]+$/.test(u) && opts?.method === 'PATCH') {
        patched.push(JSON.parse(opts.body!))
        return { ok: true, json: async () => ({ event: { id: 'e1' } }) }
      }
      if (/\/api\/events\/[^/]+$/.test(u) && opts?.method === 'DELETE') {
        deleted.push(u)
        return { ok: true, status: 204, json: async () => ({}) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch
  }

  it('edits an existing event (PATCH)', async () => {
    const patched: unknown[] = []
    mockEventApi(patched, [])
    render(<EventModal event={sampleEvent} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old title'), { target: { value: 'New title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ title: 'New title' })
  })

  it('deletes only after a confirm tap', async () => {
    const deleted: string[] = []
    mockEventApi([], deleted)
    render(<EventModal event={sampleEvent} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleted).toHaveLength(0) // first tap just confirms
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete' }))
    await waitFor(() => expect(deleted).toHaveLength(1))
  })
})
