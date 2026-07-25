import { render, screen, fireEvent } from '@testing-library/react'
import { DayView } from './DayView'
import { WeekView } from './WeekView'
import type { Countdown } from '../../lib/api'
import { ymd, startOfWeek, addDays } from './cal-utils'

// WeekView calls usePersons() on mount — stub fetch so it doesn't hit the network.
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ persons: [] }) })) as unknown as typeof fetch
})

const cd = (date: string, over: Partial<Countdown> = {}): Countdown => ({
  id: 'e1',
  title: 'Hawaii trip',
  date,
  daysLeft: 12,
  source: 'standalone',
  emoji: '🏝️',
  color: '#2F7FED',
  personId: null,
  ...over,
})

describe('countdowns on the calendar', () => {
  it('DayView renders a countdown as an all-day chip', () => {
    const day = new Date(2026, 6, 15)
    const key = ymd(day)
    render(
      <DayView day={day} events={[]} tz="UTC" countdownsByDate={{ [key]: [cd(key)] }} onOpenEvent={() => {}} onCreate={() => {}} />
    )
    expect(screen.getByText('Hawaii trip')).toBeInTheDocument()
    expect(screen.getByText('12d')).toBeInTheDocument()
  })

  it('WeekView renders a countdown in the all-day strip', () => {
    const weekStart = startOfWeek(new Date(2026, 6, 15))
    const target = ymd(addDays(weekStart, 3))
    render(
      <WeekView weekStart={weekStart} events={[]} tz="UTC" countdownsByDate={{ [target]: [cd(target)] }} onOpenEvent={() => {}} onCreate={() => {}} />
    )
    expect(screen.getByText('Hawaii trip')).toBeInTheDocument()
    expect(screen.getByText('12d')).toBeInTheDocument()
  })

  it('event-sourced countdowns are clickable and call onOpenCountdown', () => {
    const day = new Date(2026, 6, 15)
    const key = ymd(day)
    const onOpen = vi.fn()
    render(
      <DayView
        day={day}
        events={[]}
        tz="UTC"
        countdownsByDate={{ [key]: [cd(key, { source: 'event', id: 'ev-99' })] }}
        onOpenCountdown={onOpen}
        onOpenEvent={() => {}}
        onCreate={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Hawaii trip'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-99', source: 'event' }))
  })
})
