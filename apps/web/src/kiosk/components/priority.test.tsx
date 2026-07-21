import { render } from '@testing-library/react'
import { PriorityFlag, priorityMeta } from './priority'

describe('PriorityFlag', () => {
  it('renders nothing for normal (0) priority', () => {
    const { container } = render(<PriorityFlag priority={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders an Important marker for priority 1', () => {
    const { getByLabelText } = render(<PriorityFlag priority={1} />)
    expect(getByLabelText('Important')).toBeInTheDocument()
  })

  it('renders an Urgent marker for priority 2', () => {
    const { getByLabelText } = render(<PriorityFlag priority={2} />)
    expect(getByLabelText('Urgent')).toBeInTheDocument()
  })

  it('priorityMeta falls back to Normal for undefined', () => {
    expect(priorityMeta(undefined).label).toBe('Normal')
    expect(priorityMeta(2).label).toBe('Urgent')
  })
})
