import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Calendar } from './Calendar'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

function mockRange(events: unknown[]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ from: '', to: '', events }),
  })) as unknown as typeof fetch
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// The view toggle + period nav render into the topbar's right slot, so a probe
// surfaces them for assertions without mounting the whole Topbar (which would
// duplicate the month name via the live date).
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

describe('Calendar screen', () => {
  it('renders the current month grid with an event, and navigates months', async () => {
    const now = new Date()
    const todayIso = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString()
    mockRange([
      {
        id: '1',
        title: 'Dentist',
        startsAt: todayIso,
        endsAt: null,
        allDay: false,
        location: null,
        personId: 'p',
        personName: 'Kevin',
        personColor: '#2F7FED',
        personEmoji: '🐻',
      },
    ])
    renderCalendar()

    expect(await screen.findByText('Dentist')).toBeInTheDocument()
    // period label (in the topbar slot) shows the current month
    expect(screen.getByText(new RegExp(MONTHS[now.getMonth()]))).toBeInTheDocument()
    // day-of-week header from the month grid
    expect(screen.getByText('Sun')).toBeInTheDocument()

    // month navigation works
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText(new RegExp(MONTHS[next.getMonth()]))).toBeInTheDocument()
  })

  it('switches to the week and agenda views', async () => {
    mockRange([])
    renderCalendar()

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(await screen.findByText('Add an event…')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }))
    expect(await screen.findByText("What's coming up")).toBeInTheDocument()
  })
})
