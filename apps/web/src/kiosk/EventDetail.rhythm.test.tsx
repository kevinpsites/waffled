import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { EventDetail } from './EventDetail'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// The 🔁 mark on a calendar chip is terse by design, so the detail screen is where it
// gets a name. Wording stays booking-shaped ("this slot keeps a rhythm") — a rhythm is
// satisfied by the event existing, so anything about doing or finishing it would be a
// claim we never check.
function TopbarProbe() {
  return <>{useTopbarSlots().full}</>
}

const baseEvent = {
  id: 'e1',
  title: 'Temple visit',
  description: null,
  location: null,
  startsAt: '2026-08-12T14:00:00Z',
  endsAt: '2026-08-12T15:00:00Z',
  allDay: false,
  timezone: 'America/Chicago',
  rrule: null,
  recurrenceEndAt: null,
  origin: 'manual',
  originRefId: null,
  calendarName: null,
  goalId: null,
  syncState: null,
  isCountdown: false,
  personId: null,
  participants: [],
  people: [],
}

const household = { id: 'h1', name: 'Fam', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }

function mockApi(rhythmId: string | null) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/events/e1')) return { ok: true, json: async () => ({ event: { ...baseEvent, rhythmId } }) }
    if (u.includes('/api/events')) return { ok: true, json: async () => ({ events: [{ ...baseEvent, rhythmId }] }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: null }) }
    if (u.includes('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/calendar/event/e1']}>
      <TopbarSlotProvider>
        <TopbarProbe />
        <Routes>
          <Route path="/calendar/event/:id" element={<EventDetail />} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

describe('EventDetail — rhythm booking', () => {
  it('says the event keeps a rhythm when it carries one', async () => {
    mockApi('rh-1')
    renderDetail()
    await screen.findByText('Temple visit')
    expect(screen.getByText(/keeps a rhythm/i)).toBeInTheDocument()
  })

  it('says nothing on an ordinary event', async () => {
    mockApi(null)
    renderDetail()
    await screen.findByText('Temple visit')
    expect(screen.queryByText(/keeps a rhythm/i)).toBeNull()
  })
})
