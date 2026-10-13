import { render, screen, fireEvent, within } from '@testing-library/react'
import { TypefacePicker, TYPEFACES } from './TypefacePicker'

describe('TypefacePicker', () => {
  it('offers the five typeface sets as a radio group, Classic first', () => {
    render(<TypefacePicker value="classic" onChange={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: 'Typeface' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(5)
    expect(TYPEFACES.map((t) => t.id)).toEqual(['classic', 'clear', 'hyperlegible', 'friendly', 'early-reader'])
    expect(screen.getByRole('radio', { name: /Classic/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Clear/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('draws each option as a specimen, so people choose by reading', () => {
    render(<TypefacePicker value="classic" onChange={() => {}} sample={{ clock: '7:05 AM', title: 'Soccer practice', body: 'Leave by 3:40' }} />)
    expect(screen.getAllByText('7:05 AM')).toHaveLength(5)
    expect(screen.getAllByText('Soccer practice')).toHaveLength(5)
  })

  it('reports a picked typeface, but not a re-pick of the current one', () => {
    const onChange = vi.fn()
    render(<TypefacePicker value="classic" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /Classic/ }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /Early reader/ }))
    expect(onChange).toHaveBeenCalledWith('early-reader')
  })

  it('moves the choice with arrow keys, wrapping at the ends', () => {
    const onChange = vi.fn()
    render(<TypefacePicker value="classic" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: /Classic/ }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('clear')
    fireEvent.keyDown(screen.getByRole('radio', { name: /Classic/ }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('early-reader')
  })

  it('offers only the given options, in the built-in order', () => {
    render(<TypefacePicker value="clear" onChange={() => {}} options={['hyperlegible', 'classic', 'clear']} />)
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('data-tp'))).toEqual(['classic', 'clear', 'hyperlegible'])
  })

  it('compact hides the one-line notes', () => {
    const { rerender } = render(<TypefacePicker value="classic" onChange={() => {}} />)
    expect(screen.getByText(/single-storey a and g/)).toBeInTheDocument()
    rerender(<TypefacePicker value="classic" onChange={() => {}} compact />)
    expect(screen.queryByText(/single-storey a and g/)).not.toBeInTheDocument()
  })
})
