import { render, screen, within } from '@testing-library/react'
import { Kiosk } from './Kiosk'

describe('Kiosk shell', () => {
  it('renders the nav rail with all sections', () => {
    const { container } = render(<Kiosk />)
    const rail = container.querySelector('.rail') as HTMLElement
    for (const label of ['Today', 'Calendar', 'Tasks', 'Goals', 'Meals', 'Lists', 'Photos', 'Settings']) {
      expect(within(rail).getByText(label)).toBeInTheDocument()
    }
  })

  it('shows the AI capture bar', () => {
    render(<Kiosk />)
    expect(screen.getByText(/Add anything/)).toBeInTheDocument()
  })

  it('renders the Today dashboard cards', () => {
    render(<Kiosk />)
    // agenda
    expect(screen.getByText('Swim lessons')).toBeInTheDocument()
    // meals
    expect(screen.getByText('Ravioli & Sausage Bake')).toBeInTheDocument()
    expect(screen.getByText('This week’s dinners')).toBeInTheDocument()
    // family chores + grocery
    expect(screen.getByText('Family chores')).toBeInTheDocument()
    expect(screen.getByText('Grocery')).toBeInTheDocument()
    expect(screen.getByText('Ground sausage')).toBeInTheDocument()
  })
})
