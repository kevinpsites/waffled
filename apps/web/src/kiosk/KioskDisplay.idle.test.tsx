import { render, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskDisplay } from './KioskDisplay'

// Reproduce the paired-kiosk idle → screensaver path in isolation.
vi.mock('../lib/api', () => ({
  isDisplayMode: () => true,
  isKioskMode: () => true,
  clearProfileSession: vi.fn(),
  kioskApi: {
    displayConfig: vi.fn(async () => ({
      screensaverMinutes: 3,
      resetHomeMinutes: 0,
      content: 'clock',
      returnToPicker: true,
      nightDim: { enabled: false, start: '22:00', end: '07:00' },
    })),
  },
  useWeather: () => null,
  useEventsToday: () => ({ events: [] }),
  usePhotos: () => ({ photos: [] }),
  useHousehold: () => ({ household: { timezone: 'America/Chicago' } }),
}))

describe('KioskDisplay idle screensaver (paired)', () => {
  it('shows the screensaver after the configured idle time', async () => {
    vi.useFakeTimers()
    try {
      render(
        <MemoryRouter>
          <KioskDisplay><div>app</div></KioskDisplay>
        </MemoryRouter>
      )
      // let displayConfig() resolve + effects arm
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(document.querySelector('.ph-saver')).toBeNull()
      // fast-forward past the 3-min screensaver timeout
      await act(async () => { vi.advanceTimersByTime(3 * 60_000 + 1000) })
      expect(document.querySelector('.ph-saver')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
