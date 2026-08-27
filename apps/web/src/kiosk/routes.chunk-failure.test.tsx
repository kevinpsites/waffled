import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskRoutes } from './routes'

// A screen's chunk can simply fail to arrive, and on a wall-mounted kiosk this is
// an ordinary Tuesday rather than an exotic edge case: a deploy ships new hashed
// chunk names, the display has never fetched them, and then the network drops. The
// service worker precaches on install, so a build that didn't also change sw.js
// leaves those chunks uncached until something asks for them online.
//
// React re-throws a rejected lazy() import during render. With no boundary above it
// that unmounts the tree to the root — a white screen on the kitchen wall, when the
// rail and every already-loaded screen were still perfectly usable. The whole point
// of code-splitting is that one screen's absence costs you one screen.
vi.mock('./Calendar', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('a screen whose chunk fails to load', () => {
  it('keeps the kiosk chrome up and says what happened', async () => {
    render(
      <MemoryRouter initialEntries={['/calendar']}>
        <KioskRoutes />
      </MemoryRouter>
    )

    expect(await screen.findByText(/couldn’t load/i)).toBeInTheDocument()
    // The chrome is the load-bearing assertion: the family can still reach every
    // other screen, which is the difference between a degraded kiosk and a dead one.
    expect(document.querySelector('.rail')).toBeTruthy()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
  })
})
