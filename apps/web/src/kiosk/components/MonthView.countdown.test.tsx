import { render, fireEvent } from '@testing-library/react'
import { MonthView } from './MonthView'
import type { Countdown } from '../../lib/api'

const cd: Countdown = {
  id: 'c1', title: 'Disney', date: '2026-07-15', daysLeft: 12,
  source: 'standalone', emoji: '🎢', color: null, personId: null,
}

function renderMonth(onCountdownTap: (cds: Countdown[]) => void, onSelectDay: (d: string) => void) {
  return render(
    <MonthView
      year={2026}
      month={6}
      events={[]}
      tz="UTC"
      countdownsByDate={{ '2026-07-15': [cd] }}
      selectedDay="2026-07-01"
      onSelectDay={onSelectDay}
      onOpenEvent={() => {}}
      onCountdownTap={onCountdownTap}
      onCreateOnDay={() => {}}
      onMore={() => {}}
    />
  )
}

describe('MonthView countdown badge', () => {
  it('taps the badge to edit the countdown, without selecting the day', () => {
    const onCountdownTap = vi.fn()
    const onSelectDay = vi.fn()
    const { container } = renderMonth(onCountdownTap, onSelectDay)

    const badge = container.querySelector('.cal-cd') as HTMLElement
    expect(badge).toBeInTheDocument()
    fireEvent.click(badge)

    expect(onCountdownTap).toHaveBeenCalledTimes(1)
    expect(onCountdownTap.mock.calls[0][0]).toEqual([cd])
    // stopPropagation: the day-cell's select handler must NOT also fire
    expect(onSelectDay).not.toHaveBeenCalled()
  })
})
