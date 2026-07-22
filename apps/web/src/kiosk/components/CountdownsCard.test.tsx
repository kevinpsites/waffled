import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { CountdownsCard } from './CountdownsCard'

const countdowns = [
  { id: 'ev-1', title: 'School play', date: '2026-08-01', daysLeft: 11, source: 'event', emoji: '🎭', color: '#2F7FED', personId: null },
  { id: 'cd-2', title: 'Hawaii trip', date: '2026-09-15', daysLeft: 56, source: 'standalone', emoji: '🏝️', color: '#EC6049', personId: null },
]

function mockCountdowns() {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/countdowns')) {
      return { ok: true, json: async () => ({ countdowns, sleeps: false, birthdayHorizonDays: 183 }) }
    }
    return { ok: true, json: async () => ({}) }
  }) as unknown as typeof fetch
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <CountdownsCard />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe('CountdownsCard', () => {
  it('opens an event-sourced countdown at its event detail', async () => {
    mockCountdowns()
    renderCard()
    fireEvent.click(await screen.findByText('School play'))
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/calendar/event/ev-1'))
  })

  it('opens a standalone countdown at the calendar day view for its date', async () => {
    mockCountdowns()
    renderCard()
    fireEvent.click(await screen.findByText('Hawaii trip'))
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/calendar?date=2026-09-15&view=day'))
  })
})
