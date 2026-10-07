import { render, fireEvent, within } from '@testing-library/react'
import { MonthView } from './MonthView'
import type { AgendaEvent } from '../../lib/api'

const trip = {
  id: 'hamptons', title: 'Trip to the Hamptons', startsAt: '2026-09-15T00:00:00Z', endsAt: '2026-09-18T00:00:00Z',
  allDay: true, location: null, personId: null, personName: null, personColor: null, personEmoji: null, participants: [],
} as AgendaEvent

function renderMonth(selectedDay: string, onOpenEvent = vi.fn()) {
  return render(
    <MonthView
      firstDay={0}
      year={2026}
      month={8}
      events={[trip]}
      tz="UTC"
      selectedDay={selectedDay}
      onSelectDay={() => {}}
      onOpenEvent={onOpenEvent}
      onCreateOnDay={() => {}}
      onMore={() => {}}
    />
  )
}

describe('MonthView multi-day events', () => {
  it('draws a trip as one bar across its days instead of a chip per day', () => {
    const onOpenEvent = vi.fn()
    const { container } = renderMonth('2026-09-01', onOpenEvent)
    const bars = container.querySelectorAll('.cal-span')
    expect(bars).toHaveLength(1)
    expect(bars[0]).toHaveTextContent('Trip to the Hamptons')
    // Tuesday through Thursday: the third grid column, three columns wide.
    expect((bars[0] as HTMLElement).style.getPropertyValue('--span-col')).toBe('3')
    expect((bars[0] as HTMLElement).style.getPropertyValue('--span-len')).toBe('3')
    expect(container.querySelectorAll('.cal-cell .ev')).toHaveLength(0)
    fireEvent.click(bars[0])
    expect(onOpenEvent).toHaveBeenCalledWith(trip)
  })

  it('lists the trip in the day panel on a middle day', () => {
    const { container } = renderMonth('2026-09-16')
    const panel = container.querySelector('.cal-day-panel') as HTMLElement
    expect(within(panel).getByText('Trip to the Hamptons')).toBeInTheDocument()
  })
})
