import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
    expect(screen.getByText('Swim lessons')).toBeInTheDocument()
    expect(screen.getByText('Family chores')).toBeInTheDocument()
    // Today is the active rail item
    expect(within(rail()).getByText('Today').closest('a')).toHaveClass('on')
    // the chores card resolves (default stub → empty)
    expect(await screen.findByText(/No chores yet/)).toBeInTheDocument()
  })

  it('navigates to another screen when its rail item is clicked', () => {
    renderAt('/')
    fireEvent.click(within(rail()).getByText('Calendar'))

    // the Calendar placeholder shows, Today content is gone, active moved
    expect(screen.getByText(/Coming soon/)).toBeInTheDocument()
    expect(screen.queryByText('Swim lessons')).not.toBeInTheDocument()
    expect(within(rail()).getByText('Calendar').closest('a')).toHaveClass('on')
    expect(within(rail()).getByText('Today').closest('a')).not.toHaveClass('on')
  })

  it('renders a placeholder directly at a not-yet-built route', () => {
    renderAt('/meals')
    const ph = document.querySelector('.screen-placeholder') as HTMLElement
    expect(within(ph).getByText('Meals')).toBeInTheDocument()
    expect(within(ph).getByText(/Coming soon/)).toBeInTheDocument()
  })
})
