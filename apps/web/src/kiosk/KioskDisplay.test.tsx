import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskDisplay } from './KioskDisplay'

const mocks = vi.hoisted(() => ({
  displayMode: false,
  identityScope: vi.fn<() => string | null>(() => null),
  transitionInProgress: vi.fn(() => false),
  waitForTransition: vi.fn(() => Promise.resolve()),
}))

vi.mock('../lib/api', () => ({
  currentIdentityScope: mocks.identityScope,
  isDisplayMode: () => mocks.displayMode,
  isKioskMode: () => false,
  clearProfileSession: vi.fn(async () => {}),
  kioskApi: { displayConfig: vi.fn() },
  useWeather: () => null,
  useEventsToday: () => ({ events: [] }),
  usePhotos: () => ({ photos: [] }),
  useHousehold: () => ({ household: null }),
}))

vi.mock('../lib/powersync/principal-transition', () => ({
  principalTransitionInProgress: mocks.transitionInProgress,
  waitForPrincipalTransition: mocks.waitForTransition,
}))

// The load-bearing safety property: a normal/dev browser (display mode off) gets
// ZERO ambient behavior — no screensaver, no dim overlay, no data fetching layer.
describe('KioskDisplay', () => {
  beforeEach(() => {
    mocks.displayMode = false
    mocks.identityScope.mockReset()
    mocks.identityScope.mockReturnValue(null)
    mocks.transitionInProgress.mockReset()
    mocks.transitionInProgress.mockReturnValue(false)
    mocks.waitForTransition.mockReset()
    mocks.waitForTransition.mockResolvedValue(undefined)
  })

  it('is a no-op when display mode is off (dev/normal web)', () => {
    try { localStorage.clear() } catch { /* ignore */ }
    render(
      <MemoryRouter>
        <KioskDisplay><div>app body</div></KioskDisplay>
      </MemoryRouter>
    )
    expect(screen.getByText('app body')).toBeInTheDocument()
    expect(document.querySelector('.ph-saver')).toBeNull()
    expect(document.querySelector('.kiosk-dim')).toBeNull()
  })

  it('remounts children when the scope changes after render but before subscription', async () => {
    let mounts = 0
    function ScopedChild() {
      const [instance] = useState(() => ++mounts)
      return <div>app instance {instance}</div>
    }
    // The initial state and render belong to A. By the layout subscription the
    // remote transition has already finished with B and no marker remains.
    mocks.identityScope
      .mockReturnValueOnce('session:account-a')
      .mockReturnValueOnce('session:account-a')
      .mockReturnValue('session:account-b')

    render(
      <MemoryRouter>
        <KioskDisplay><ScopedChild /></KioskDisplay>
      </MemoryRouter>
    )

    expect(await screen.findByText('app instance 2')).toBeInTheDocument()
    expect(mounts).toBe(2)
  })
})
