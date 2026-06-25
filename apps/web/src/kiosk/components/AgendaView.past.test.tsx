import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AgendaView } from './AgendaView'

// Device timezone so localDate() buckets our events on "today" the same way the
// component's todayKey (ymd of new Date()) does.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toISOString()

// One event that already ended (started 2h ago, ended 1h ago) and one still to
// come (in 2h) — both today.
const events = [
  { id: 'past', seriesId: null, occurrenceStart: null, title: 'Morning standup', allDay: false, startsAt: iso(-120), endsAt: iso(-60), personColor: '#2F7FED', participants: [] },
  { id: 'future', seriesId: null, occurrenceStart: null, title: 'Evening walk', allDay: false, startsAt: iso(120), endsAt: iso(180), personColor: '#25A368', participants: [] },
] as unknown as Parameters<typeof AgendaView>[0]['events']

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) } // heads-up etc. — catch handles it
  }) as unknown as typeof fetch
})

describe('AgendaView past-event fading', () => {
  it('fades a today event that has already ended, not an upcoming one', async () => {
    render(
      <MemoryRouter>
        <AgendaView events={events} tz={TZ} onOpenEvent={() => {}} onPickDate={() => {}} onCreate={() => {}} />
      </MemoryRouter>
    )
    const pastRow = (await screen.findByText('Morning standup')).closest('.ag-row')
    const futureRow = (await screen.findByText('Evening walk')).closest('.ag-row')
    await waitFor(() => expect(pastRow).toHaveClass('past'))
    expect(futureRow).not.toHaveClass('past')
  })
})
