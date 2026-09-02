import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { EventModal } from './EventModal'

// Linking an event that already exists to a rhythm.
//
// A scheduling rhythm is satisfied by "an event in this period points at me", and until
// now the only event that could point at one was an event the rhythm booked itself. So a
// family outing put on the calendar the ordinary way left the rhythm nagging you to book
// the thing sitting right there. The back-reference was always writable through the API;
// what was missing was any way for a person to say so.
//
// Only SCHEDULING rhythms are offered. A completion rhythm closes its period on "I did
// it", so an event pointing at one would satisfy nothing — offering it would be a promise
// the register never keeps.

const schedulingRhythm = {
  id: 'rh-1',
  title: 'Family outing',
  emoji: '🎡',
  notes: null,
  personId: null,
  satisfiedBy: 'scheduling',
  every: '1 mon',
  startsOn: '2026-06-01',
  autoSchedule: false,
  rrule: null,
  leadTime: '7 days',
  lastCompletedAt: null,
  nextDueAt: null,
  isActive: true,
  currentPeriodStart: '2026-06-01',
  currentPeriodEnd: '2026-07-01',
  satisfied: false,
  bookedAt: null,
  bookedAllDay: null,
  hasSeries: false,
}

const completionRhythm = {
  ...schedulingRhythm,
  id: 'rh-2',
  title: 'Change the furnace filter',
  emoji: '🌬️',
  satisfiedBy: 'completion',
  startsOn: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  nextDueAt: '2026-07-01T12:00:00Z',
}

const sampleEvent = {
  id: 'e1',
  title: 'Zoo trip',
  startsAt: '2026-06-09T22:00:00Z',
  endsAt: null,
  allDay: false,
  location: null,
  personId: null,
  personName: null,
  personColor: null,
  personEmoji: null,
  participants: [],
  rhythmId: null as string | null,
}

function mockApi(patched: Record<string, unknown>[], rhythms: unknown[] = [schedulingRhythm, completionRhythm]) {
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    if (u.includes('/api/rhythms')) return { ok: true, json: async () => ({ rhythms }) }
    if (/\/api\/events\/[^/]+$/.test(u) && opts?.method === 'PATCH') {
      patched.push(JSON.parse(opts.body!))
      return { ok: true, json: async () => ({ event: { id: 'e1' } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const renderModal = (event: typeof sampleEvent) =>
  render(
    <MemoryRouter>
      <EventModal event={event} onClose={vi.fn()} onSaved={vi.fn()} />
    </MemoryRouter>
  )

describe('EventModal — linking an event to a rhythm', () => {
  it('offers the household’s scheduling rhythms, and only those', async () => {
    mockApi([])
    renderModal(sampleEvent)
    const picker = await screen.findByLabelText(/Keeps a rhythm/i)
    expect(picker).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Family outing/ })).toBeInTheDocument()
    // A completion rhythm can never be settled by an event existing.
    expect(screen.queryByRole('option', { name: /furnace filter/i })).toBeNull()
  })

  it('saves the link on an event booked outside the rhythms module', async () => {
    const patched: Record<string, unknown>[] = []
    mockApi(patched)
    renderModal(sampleEvent)
    const picker = await screen.findByLabelText(/Keeps a rhythm/i)
    fireEvent.change(picker, { target: { value: 'rh-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ rhythmId: 'rh-1' })
  })

  it('sends an explicit null to unlink, which is the only thing that clears it', async () => {
    // The PowerSync PUT sink coalesces rhythm_id precisely so an older client cannot blank
    // it by omission, so an unlink has to be stated rather than implied.
    const patched: Record<string, unknown>[] = []
    mockApi(patched)
    renderModal({ ...sampleEvent, rhythmId: 'rh-1' })
    const picker = await screen.findByLabelText(/Keeps a rhythm/i)
    expect((picker as HTMLSelectElement).value).toBe('rh-1')
    fireEvent.change(picker, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toHaveProperty('rhythmId', null)
  })

  it('stays out of the way when the household runs no scheduling rhythms', async () => {
    mockApi([], [completionRhythm])
    renderModal(sampleEvent)
    await screen.findByDisplayValue('Zoo trip')
    expect(screen.queryByLabelText(/Keeps a rhythm/i)).toBeNull()
  })
})
