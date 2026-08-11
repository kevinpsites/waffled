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

    // The event shows in the grid (and, if today is the 15th, the day panel too).
    expect((await screen.findAllByText('Dentist')).length).toBeGreaterThan(0)
    // period label (in the topbar slot) shows the current month + year. Match the
    // "Month YYYY" pill specifically — the month name alone now also appears in the
    // day panel's date line ("Monday, July 7").
    expect(
      screen.getByRole('button', { name: new RegExp(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`) })
    ).toBeInTheDocument()
    // day-of-week header from the month grid
    expect(screen.getByText('Sun')).toBeInTheDocument()

    // month navigation works
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(
      screen.getByRole('button', { name: new RegExp(`${MONTHS[next.getMonth()]} ${next.getFullYear()}`) })
    ).toBeInTheDocument()
  })

  it('switches to the week and agenda views', async () => {
    mockRange([])
    renderCalendar()

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    expect(await screen.findByText('Add an event…')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }))
    expect(await screen.findByText("What's coming up")).toBeInTheDocument()
  })

  // The app's big header shows TODAY's date, which reads as the answer to "what
  // am I looking at?" — so paging to another month left no obvious sign you had
  // moved. The grid carries its own period heading, called out when it isn't now.
  it('heads the grid with the period being viewed, offering a way back when away', async () => {
    mockRange([])
    const now = new Date()
    renderCalendar()
    // View AND anchor are remembered across mounts, and the previous tests left
    // both moved — reset to Month/today (the period pill is "jump to today").
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(document.querySelector('.cal-period') as HTMLElement)

    const heading = await screen.findByTestId('cal-period-heading')
    expect(heading).toHaveTextContent(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`)
    // Viewing the current month is the unremarkable case — nothing to jump back to.
    expect(screen.queryByRole('button', { name: 'Back to today' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))

    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    expect(await screen.findByTestId('cal-period-heading')).toHaveTextContent(
      `${MONTHS[next.getMonth()]} ${next.getFullYear()}`
    )
    // The heading already names the month, so the control just offers the way back.
    const back = screen.getByRole('button', { name: 'Back to today' })

    fireEvent.click(back)
    expect(await screen.findByTestId('cal-period-heading')).toHaveTextContent(
      `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
    )
    expect(screen.queryByRole('button', { name: 'Back to today' })).toBeNull()
  })
})
