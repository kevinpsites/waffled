import { render, screen, fireEvent } from '@testing-library/react'
import { PersonPickModal } from './PersonPickModal'
import type { Person } from '../../lib/api/persons'

const people = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: '🐻', colorHex: '#aa0000' },
  { id: 'p2', name: 'Lottie', memberType: 'kid', isAdmin: false, avatarEmoji: '🦄', colorHex: null },
] as Person[]

describe('PersonPickModal', () => {
  it('calls onPick with the tapped person id', () => {
    const onPick = vi.fn()
    render(<PersonPickModal title="Who?" people={people} onPick={onPick} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Lottie/ }))
    expect(onPick).toHaveBeenCalledWith('p2')
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    render(<PersonPickModal title="Who?" people={people} onPick={vi.fn()} onCancel={onCancel} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('cancels on backdrop click but not card click', () => {
    const onCancel = vi.fn()
    const { container } = render(<PersonPickModal title="Who?" people={people} onPick={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('Who?'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('.modal-overlay')!)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
