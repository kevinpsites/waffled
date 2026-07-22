import { render } from '@testing-library/react'
import { PriorityFlag, priorityMeta } from './priority'

describe('PriorityFlag', () => {
  it('renders nothing for normal (3) priority', () => {
    const { container } = render(<PriorityFlag priority={3} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for below-normal priorities (1, 2)', () => {
    expect(render(<PriorityFlag priority={1} />).container.firstChild).toBeNull()
    expect(render(<PriorityFlag priority={2} />).container.firstChild).toBeNull()
  })

  it('renders a High marker for priority 4', () => {
    const { getByLabelText } = render(<PriorityFlag priority={4} />)
    expect(getByLabelText('High')).toBeInTheDocument()
  })

  it('renders an Urgent marker for priority 5', () => {
    const { getByLabelText } = render(<PriorityFlag priority={5} />)
    expect(getByLabelText('Urgent')).toBeInTheDocument()
  })

  it('priorityMeta falls back to Normal (3) for undefined', () => {
    expect(priorityMeta(undefined).label).toBe('Normal')
    expect(priorityMeta(1).label).toBe('Not urgent')
    expect(priorityMeta(5).label).toBe('Urgent')
  })
})
