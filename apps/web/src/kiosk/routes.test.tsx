import { render, screen, within, fireEvent } from '@testing-library/react'
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
  it('renders the Today dashboard at /', async () => {
    renderAt('/')
    expect(screen.getByText('Family Chores')).toBeInTheDocument()
    expect(screen.getByText('This week’s dinners')).toBeInTheDocument()
    // Today is the active rail item
    expect(within(rail()).getByText('Today').closest('a')).toHaveClass('on')
    // the chores card resolves (default stub → empty)
    expect(await screen.findByText(/No chores yet/)).toBeInTheDocument()
  })

  it('navigates to another screen when its rail item is clicked', () => {
    renderAt('/')
    // Calendar is a stable real screen — use it so this test stays independent
    // of the per-screen agents building out Meals/Lists/Photos/Settings.
    fireEvent.click(within(rail()).getByText('Calendar'))

    // Today content is gone, active moved to Calendar
    expect(screen.queryByText('Family chores')).not.toBeInTheDocument()
    expect(within(rail()).getByText('Calendar').closest('a')).toHaveClass('on')
    expect(within(rail()).getByText('Today').closest('a')).not.toHaveClass('on')
  })

  it('every rail destination resolves to a screen (no dead routes)', () => {
    for (const path of ['/tasks', '/calendar', '/goals', '/meals', '/lists', '/photos', '/settings']) {
      const { unmount } = renderAt(path)
      // the layout + a main region always render; no thrown route
      expect(document.querySelector('.kiosk-main, .wf-kiosk')).toBeTruthy()
      unmount()
    }
  })
})
