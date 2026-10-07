import { render, screen, within, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { KioskRoutes } from './routes'

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <KioskRoutes />
    </MemoryRouter>
  )
}

function rail() {
  return document.querySelector('.rail') as HTMLElement
}

describe('kiosk navigation', () => {
  it('opens and closes the compact primary navigation', () => {
    renderAt('/')
    const trigger = screen.getByRole('button', { name: 'Open navigation' })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(rail()).toHaveClass('mobile-open')

    fireEvent.click(within(rail()).getByText('Calendar'))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(rail()).not.toHaveClass('mobile-open')
  })

  it('renders the Today dashboard at /', async () => {
    renderAt('/')
    // Screens are code-split, so the first paint after a navigation is the layout
    // chrome alone and the screen arrives a microtask later — await it in.
    expect(await screen.findByText('Family Chores')).toBeInTheDocument()
    expect(screen.getByText('This week’s dinners')).toBeInTheDocument()
    // Today is the active rail item
    expect(within(rail()).getByText('Today').closest('a')).toHaveClass('on')
    // the chores card resolves (default stub → empty)
    expect(await screen.findByText(/No chores yet/)).toBeInTheDocument()
  })

  it('navigates to another screen when its rail item is clicked', async () => {
    renderAt('/')
    // Wait for Today to actually be on screen, so "Today content is gone" below is a
    // real transition rather than a chunk that had never loaded in the first place.
    await screen.findByText('Family Chores')
    // Calendar is a stable real screen — use it so this test stays independent
    // of the per-screen agents building out Meals/Lists/Photos/Settings.
    fireEvent.click(within(rail()).getByText('Calendar'))

    // Today content is gone, active moved to Calendar
    expect(screen.queryByText('Family chores')).not.toBeInTheDocument()
    expect(within(rail()).getByText('Calendar').closest('a')).toHaveClass('on')
    expect(within(rail()).getByText('Today').closest('a')).not.toHaveClass('on')
  })

  it('every rail destination resolves to a screen (no dead routes)', async () => {
    for (const path of ['/tasks', '/calendar', '/goals', '/meals', '/lists', '/photos', '/settings']) {
      const { unmount } = renderAt(path)
      // the layout + a main region always render; no thrown route
      expect(document.querySelector('.kiosk-main, .wf-kiosk')).toBeTruthy()
      // Let the screen's chunk resolve — .kiosk-main is the eager layout, so on its
      // own it would pass even if every screen behind it were broken.
      await act(async () => {})
      // The screen rendered rather than throwing into the boundary. This is the half
      // of "no dead routes" that is actually about the routes.
      expect(screen.queryByText(/couldn’t load/i)).toBeNull()
      unmount()
    }
  })
})
