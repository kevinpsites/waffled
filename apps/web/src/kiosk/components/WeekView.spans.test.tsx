import { render, fireEvent } from '@testing-library/react'
import { WeekView } from './WeekView'
import type { AgendaEvent } from '../../lib/api'

// Multi-day all-day events in the week's all-day strip draw as one bar across their days, like
// the month view (month-spans.ts), instead of a chip on their first day only.
function trip(id: string, title: string, first: string, endExclusive: string): AgendaEvent {
  return {
    id, title, startsAt: `${first}T00:00:00Z`, endsAt: `${endExclusive}T00:00:00Z`, allDay: true,
    location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [],
  } as AgendaEvent
}

function renderWeek(events: AgendaEvent[], onOpenEvent = vi.fn()) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ persons: [] }) })) as unknown as typeof fetch
  return render(
    <WeekView
      weekStart={new Date('2026-09-13T00:00:00')}
      events={events}
      tz="UTC"
      onOpenEvent={onOpenEvent}
      onCreate={() => {}}
    />
  )
}

describe('WeekView multi-day events', () => {
  it('draws a trip as one bar across its days in the all-day strip', () => {
    const hamptons = trip('hamptons', 'Trip to the Hamptons', '2026-09-15', '2026-09-18')
    const onOpenEvent = vi.fn()
    const { container } = renderWeek([hamptons], onOpenEvent)
    const bars = container.querySelectorAll<HTMLElement>('.wk-span')
    expect(bars).toHaveLength(1)
    expect(bars[0]).toHaveTextContent('Trip to the Hamptons')
    // Tuesday through Thursday: the grid's first column is the hour rail.
    expect(bars[0].style.getPropertyValue('--span-col')).toBe('4')
    expect(bars[0].style.getPropertyValue('--span-len')).toBe('3')
    expect(container.querySelectorAll('.wk-allday-cell .wk-allday-ev')).toHaveLength(0)
    fireEvent.click(bars[0])
    expect(onOpenEvent).toHaveBeenCalledWith(hamptons)
  })

  it('squares off a trip that runs past the end of the week and keeps one-day events as chips', () => {
    const { container } = renderWeek([
      trip('camping', 'Camping', '2026-09-18', '2026-09-23'),
      trip('birthday', 'Birthday', '2026-09-16', '2026-09-17'),
    ])
    const bar = container.querySelector<HTMLElement>('.wk-span')!
    expect(bar).toHaveTextContent('Camping')
    expect(bar).toHaveClass('cont-after')
    expect(bar).not.toHaveClass('cont-before')
    const chips = container.querySelectorAll('.wk-allday-cell .wk-allday-ev')
    expect([...chips].map((c) => c.textContent)).toEqual(['Birthday'])
  })
})
