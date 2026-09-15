import { render, screen, fireEvent } from '@testing-library/react'
import { MonthDayPanel } from './MonthDayPanel'

describe('MonthDayPanel', () => {
  // A text "＋" is a fullwidth glyph with its own side bearing, so it sat off-centre in the round
  // button; the icon is drawn on the button's own 24-unit grid.
  it('draws its add button with the plus icon, not a text glyph', () => {
    const onCreate = vi.fn()
    render(<MonthDayPanel day="2026-09-15" events={[]} tz="UTC" onOpenEvent={() => {}} onCreate={onCreate} />)
    const add = screen.getByRole('button', { name: 'Add an event on this day' })
    expect(add.querySelector('svg')).not.toBeNull()
    expect(add.textContent).toBe('')
    fireEvent.click(add)
    expect(onCreate).toHaveBeenCalledWith('2026-09-15')
  })
})
