import { render, screen } from '@testing-library/react'
import { BookRhythmModal } from './BookRhythmModal'

// Booking a period is clamped to that period — the date input carries min/max, so you
// physically cannot pick a day that wouldn't count. That clamp was never *stated*, and a
// native picker opens on the month holding today: on the last day of a weekly period the
// six other legal days sit in the previous month, one back-arrow away and invisible. The
// screen looked like it only ever allowed today. The window has to be said out loud.

const temple = {
  id: 'r-temple',
  title: 'Temple visit',
  emoji: '🛕',
  notes: null,
  personId: null,
  satisfiedBy: 'scheduling' as const,
  every: '7 days',
  startsOn: '2026-08-19',
  autoSchedule: false,
  rrule: null,
  leadTime: '3 days',
  lastCompletedAt: null,
  nextDueAt: null,
  isActive: true,
}

// periodEnd is the EXCLUSIVE next boundary, so the last day that counts is Sep 1.
const period = { rhythm: temple, periodStart: '2026-08-26', periodEnd: '2026-09-02', hasSeries: false }

const open = (item = period) =>
  render(<BookRhythmModal item={item} onClose={() => {}} />)

afterEach(() => vi.useRealTimers())

const at = (iso: string) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe('the bookable window is always visible', () => {
  it('says today is the last day, when it is', () => {
    at('2026-09-01T09:00:00')
    open()
    // Not "between Aug 26 and Sep 1": six of those seven days have already gone. The
    // only fact worth having is that the window shuts tonight.
    expect(screen.getByText(/last day/i)).toBeInTheDocument()
  })

  it('names the deadline while days remain', () => {
    at('2026-08-28T09:00:00')
    open()
    const line = screen.getByText(/counts/i)
    expect(line.textContent).toMatch(/Sep 1/)
    // and how much runway is left, so "up to Sep 1" isn't a date to count on fingers
    expect(line.textContent).toMatch(/5 days/)
  })

  // The two out-of-window branches are only reachable when the BROWSER's day disagrees
  // with the household's — the period was tiled server-side in the household timezone, and
  // `period_start` is by construction the latest boundary at or before the household's
  // today, so server-side `today` is always inside the window. A kiosk left on the wrong
  // zone, or a phone that travelled, is what puts us outside it.
  //
  // The server owns the period. So a clock landing outside the window is a disagreement,
  // not a verdict: name the span and let the min/max clamp — which uses the server's own
  // dates — do the deciding.
  it('names both ends when our clock sits before the window', () => {
    at('2026-08-24T09:00:00')
    open()
    const line = screen.getByText(/counts/i)
    expect(line.textContent).toMatch(/Aug 26/)
    expect(line.textContent).toMatch(/Sep 1/)
  })

  it('never declares the period closed while the booking would still land', () => {
    // Household in Los Angeles, browser a day ahead: server-side the weekly period
    // Aug 26 → Sep 2 is still open and a booking WOULD settle it.
    at('2026-09-02T09:00:00')
    open()
    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/closed/i)
    // and the button it sits beside is enabled, which is why the claim would be a lie
    expect(screen.getByRole('button', { name: /put it on the calendar/i })).toBeEnabled()
    expect(screen.getByText(/counts/i).textContent).toMatch(/Aug 26/)
  })

  it('still clamps the input to the period', () => {
    at('2026-09-01T09:00:00')
    open()
    const input = screen.getByLabelText('Date') as HTMLInputElement
    expect(input.min).toBe('2026-08-26')
    expect(input.max).toBe('2026-09-01')
  })
})
