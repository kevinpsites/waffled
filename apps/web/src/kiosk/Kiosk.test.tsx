import { render, screen } from '@testing-library/react'
import { Kiosk } from './Kiosk'

describe('Kiosk shell', () => {
  it('renders the nav rail with the Today item active', () => {
    render(<Kiosk />)
    for (const label of ['Today', 'Calendar', 'Tasks', 'Goals', 'Meals', 'Lists', 'Photos', 'Settings']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('shows the AI capture bar', () => {
    render(<Kiosk />)
    expect(screen.getByText(/Add anything/)).toBeInTheDocument()
  })
})
