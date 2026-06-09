import { render, screen, fireEvent } from '@testing-library/react'
import { Calendar } from './Calendar'

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
    render(<Calendar />)

    expect(await screen.findByText('Dentist')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(MONTHS[now.getMonth()]))).toBeInTheDocument()
    // day-of-week header
    expect(screen.getByText('Sun')).toBeInTheDocument()

    // month navigation works
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText(new RegExp(MONTHS[next.getMonth()]))).toBeInTheDocument()
  })
})
