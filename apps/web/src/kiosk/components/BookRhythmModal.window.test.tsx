import { render, screen } from '@testing-library/react'
import { BookRhythmModal } from './BookRhythmModal'

// A period wider than the window it accepts bookings in.
//
// "Date night, in the first week of the month" is a monthly cadence — the period owns the
// grid and the skips and says how often — with a seven-day window inside it. Everything
// this modal says and allows has to follow the WINDOW: the picker's bounds, the deadline
// it names, and the days it counts. Told the period instead, it would happily offer the
// 20th of the month, take the booking, and leave the card still asking.

const dateNight = {
  id: 'r-date',
  title: 'Date night',
  emoji: '🕯️',
  notes: null,
  personId: null,
  satisfiedBy: 'scheduling' as const,
  every: '1 mon',
  startsOn: '2026-09-01',
  autoSchedule: false,
  rrule: null,
  bookWithin: '7 days',
  leadTime: '7 days',
  lastCompletedAt: null,
  nextDueAt: null,
  isActive: true,
}

// The period runs Sep 1 → Oct 1; the window closes Sep 8, so the last day that counts is
// Sep 7. Both are carried, because they answer different questions.
const period = {
  rhythm: dateNight,
  periodStart: '2026-09-01',
  periodEnd: '2026-10-01',
  windowEnd: '2026-09-08',
  hasSeries: false,
}

afterEach(() => vi.useRealTimers())

const at = (iso: string) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe('booking a period that only accepts part of itself', () => {
  it('clamps the picker to the window, not the period', () => {
    at('2026-09-02T09:00:00')
    render(<BookRhythmModal item={period} onClose={() => {}} />)
    const day = screen.getByLabelText(/^date$/i) as HTMLInputElement
    expect(day.min).toBe('2026-09-01')
    // Sep 7, not Sep 30. A booking on the 20th settles nothing.
    expect(day.max).toBe('2026-09-07')
  })

  it('names the window’s deadline and counts the days to it', () => {
    at('2026-09-02T09:00:00')
    render(<BookRhythmModal item={period} onClose={() => {}} />)
    const line = screen.getByText(/counts/i)
    expect(line.textContent).toMatch(/Sep 7/)
    expect(line.textContent).toMatch(/6 days/)
  })

  it('says the window has closed on its last day, though the period runs on', () => {
    at('2026-09-07T09:00:00')
    render(<BookRhythmModal item={period} onClose={() => {}} />)
    expect(screen.getByText(/last day/i)).toBeInTheDocument()
  })

  it('behaves exactly as before when the window is the whole period', () => {
    // Every rhythm that predates the column: windowEnd and periodEnd are the same date.
    at('2026-09-02T09:00:00')
    render(
      <BookRhythmModal
        item={{ ...period, rhythm: { ...dateNight, bookWithin: null }, windowEnd: '2026-10-01' }}
        onClose={() => {}}
      />
    )
    expect((screen.getByLabelText(/^date$/i) as HTMLInputElement).max).toBe('2026-09-30')
  })
})
