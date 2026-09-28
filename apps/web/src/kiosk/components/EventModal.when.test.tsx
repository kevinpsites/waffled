import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { EventModal } from './EventModal'

// The When card — All day, Starts and Ends in one field, like the iPhone editor. All-day ends
// save EXCLUSIVE (noon the day after the last day); timed ends can land on a later day.
function captureApi() {
  const posted: Record<string, unknown>[] = []
  const patched: Record<string, unknown>[] = []
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (u.includes('/api/events') && opts?.method === 'POST') {
      posted.push(JSON.parse(opts.body!))
      return { ok: true, json: async () => ({ event: { id: 'e1' } }) }
    }
    if (/\/api\/events\/[^/]+$/.test(u) && opts?.method === 'PATCH') {
      patched.push(JSON.parse(opts.body!))
      return { ok: true, json: async () => ({ event: { id: 'e1' } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { posted, patched }
}

const local = (s: string) => new Date(s).toISOString()

describe('EventModal When card', () => {
  it('saves an all-day trip with its end date as noon the day after its last day', async () => {
    const { posted } = captureApi()
    render(<MemoryRouter><EventModal date="2026-09-15" onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('Soccer practice'), { target: { value: 'Trip' } })
    fireEvent.click(screen.getByRole('switch', { name: 'All day' }))
    expect(screen.getByRole('button', { name: 'Start date' })).toHaveTextContent('Sep 15, 2026')
    expect(screen.queryByRole('button', { name: 'Start time' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'End date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sep 17, 2026' }))
    expect(screen.getByRole('button', { name: 'End date' })).toHaveTextContent('Sep 17, 2026')

    fireEvent.click(screen.getByRole('button', { name: /Add event/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      allDay: true,
      startsAt: local('2026-09-15T12:00'),
      endsAt: local('2026-09-18T12:00'),
    })
  })

  it("keeps a synced trip's end when something else is edited", async () => {
    const { patched } = captureApi()
    const trip = {
      id: 'e1', title: 'Hamptons', startsAt: local('2026-09-15T00:00'), endsAt: local('2026-09-18T00:00'), allDay: true,
      location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [],
    }
    render(<MemoryRouter><EventModal event={trip} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'End date' })).toHaveTextContent('Sep 17, 2026')
    fireEvent.change(screen.getByDisplayValue('Hamptons'), { target: { value: 'Hamptons weekend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ allDay: true, endsAt: local('2026-09-18T12:00') })
  })

  it('saves a timed end on a later day', async () => {
    const { posted } = captureApi()
    render(<MemoryRouter><EventModal date="2026-09-14" onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('Soccer practice'), { target: { value: 'Red-eye' } })
    expect(screen.getByRole('button', { name: 'Start time' })).toHaveTextContent('5:00 PM')
    expect(screen.getByRole('button', { name: 'End time' })).toHaveTextContent('6:00 PM')

    fireEvent.click(screen.getByRole('button', { name: 'End date' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sep 15, 2026' }))
    fireEvent.click(screen.getByRole('button', { name: 'End time' }))
    fireEvent.click(screen.getByRole('option', { name: '9:00 AM' }))
    expect(screen.getByRole('button', { name: 'End date' })).toHaveTextContent('Sep 15, 2026')

    fireEvent.click(screen.getByRole('button', { name: /Add event/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ allDay: false, startsAt: local('2026-09-14T17:00'), endsAt: local('2026-09-15T09:00') })
  })
})
