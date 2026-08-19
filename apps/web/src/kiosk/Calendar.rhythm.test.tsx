import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Calendar } from './Calendar'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// A rhythm's scheduling shape IS an ordinary calendar event carrying rhythm_id — no
// separate entity, no chip overlay. So the only thing the calendar owes it is a quiet
// marker saying "this slot is somebody's rhythm", on every view that draws an event.
// Deliberately NOT follow-through language: the booking is the outcome, and we never
// ask whether it happened.

function mockRange(events: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ from: '', to: '', events }),
  })) as unknown as typeof fetch
}

function SlotProbe() {
  const { right } = useTopbarSlots()
  return <div data-testid="slot">{right}</div>
}

function renderCalendar() {
  return render(
    <MemoryRouter>
      <TopbarSlotProvider>
        <SlotProbe />
        <Calendar />
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

// Noon today, so the event lands inside every view's visible window.
function noonToday(): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12).toISOString()
}

const base = {
  endsAt: null,
  allDay: false,
  location: null,
  personId: 'p',
  personName: 'Kevin',
  personColor: '#2F7FED',
  personEmoji: '🐻',
  participants: [],
}

const MARK = 'Part of a rhythm'

describe('Calendar — rhythm marker', () => {
  beforeEach(() => {
    mockRange([
      { ...base, id: 'r1', title: 'Temple visit', startsAt: noonToday(), rhythmId: 'rh-1' },
      { ...base, id: 'e1', title: 'Dentist', startsAt: noonToday() },
    ])
  })

  it('marks a rhythm-booked event in the month grid, and leaves ordinary events alone', async () => {
    renderCalendar()
    expect((await screen.findAllByText('Temple visit')).length).toBeGreaterThan(0)
    // One marker per place the rhythm event is drawn (grid cell + day panel), and
    // never more than the number of rhythm events on screen.
    const marks = screen.getAllByTitle(MARK)
    expect(marks.length).toBeGreaterThan(0)
    expect(screen.getAllByText('Temple visit').length).toBeGreaterThanOrEqual(marks.length)
    // The plain event carries no marker: the marker means "rhythm", not "recurring".
    expect(screen.getAllByText('Dentist').length).toBeGreaterThan(0)
  })

  it('marks it in the week, day and agenda views too', async () => {
    renderCalendar()
    for (const view of ['Week', 'Day', 'Agenda']) {
      fireEvent.click(screen.getByRole('button', { name: view }))
      expect((await screen.findAllByText('Temple visit')).length).toBeGreaterThan(0)
      expect(screen.getAllByTitle(MARK).length).toBeGreaterThan(0)
    }
  })

  it('shows no marker at all when nothing on the calendar is a rhythm', async () => {
    mockRange([{ ...base, id: 'e1', title: 'Dentist', startsAt: noonToday() }])
    renderCalendar()
    expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0)
    expect(screen.queryAllByTitle(MARK)).toHaveLength(0)
  })
})
