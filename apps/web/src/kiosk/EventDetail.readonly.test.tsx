import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { EventDetail } from './EventDetail'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// An event imported from a subscribed ICS feed is a read-only mirror of somebody
// else's calendar — the API refuses to patch/delete it (409 ReadOnlyEvent), so the
// detail screen must not offer Edit/Delete affordances that can only fail.
function TopbarProbe() {
  return <>{useTopbarSlots().full}</>
}

const baseEvent = {
  id: 'e1',
  title: 'Half day — early release',
  description: null,
  location: null,
  startsAt: '2026-08-12T14:00:00Z',
  endsAt: '2026-08-12T15:00:00Z',
  allDay: false,
  timezone: 'America/Chicago',
  rrule: null,
  recurrenceEndAt: null,
  origin: 'ics',
  originRefId: 'feed-1',
  calendarName: 'School calendar',
  goalId: null,
  syncState: 'synced',
  isCountdown: false,
  personId: null,
  participants: [],
  people: [],
}

const household = { id: 'h1', name: 'Fam', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }

function mockApi(origin: string) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/events/e1')) return { ok: true, json: async () => ({ event: { ...baseEvent, origin } }) }
    if (u.includes('/api/events')) return { ok: true, json: async () => ({ events: [{ ...baseEvent, origin }] }) }
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

describe('EventDetail — feed events are read-only', () => {
  it('hides Edit and Delete for an ICS-feed event and says where it came from', async () => {
    mockApi('ics')
    renderDetail()

    await screen.findByText('Half day — early release')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull()
    })
    // Still useful: you can set a reminder on someone else's event.
    expect(screen.getByRole('button', { name: /Remind me/ })).toBeInTheDocument()
    expect(screen.getByText(/subscribed calendar feed/i)).toBeInTheDocument()
  })

  it('still offers Edit and Delete for a normal event', async () => {
    mockApi('manual')
    renderDetail()

    await screen.findByText('Half day — early release')
    expect(await screen.findByRole('button', { name: /Edit/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument()
  })
})
