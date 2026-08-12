import { render, screen, fireEvent } from '@testing-library/react'
import { ColorPicker, COLOR_SWATCHES } from './ColorPicker'

// The eight presets, plus a ninth "custom" swatch that opens a free hex picker —
// so a family isn't limited to the preset palette.

describe('ColorPicker', () => {
  it('renders the eight presets and a custom swatch', () => {
    render(<ColorPicker value={COLOR_SWATCHES[0]} onChange={() => {}} />)
    for (const c of COLOR_SWATCHES) expect(screen.getByLabelText(`color ${c}`)).toBeInTheDocument()
    expect(COLOR_SWATCHES).toHaveLength(8)
    expect(screen.getByLabelText('Custom color')).toBeInTheDocument()
  })

  it('reports a picked preset', () => {
    const onChange = vi.fn()
    render(<ColorPicker value={COLOR_SWATCHES[0]} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText(`color ${COLOR_SWATCHES[2]}`))
    expect(onChange).toHaveBeenCalledWith(COLOR_SWATCHES[2])
  })

  it('reports a free hex from the custom picker', () => {
    const onChange = vi.fn()
    render(<ColorPicker value={COLOR_SWATCHES[0]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Pick a custom color'), { target: { value: '#123456' } })
    expect(onChange).toHaveBeenCalledWith('#123456')
  })

  it('shows an off-palette color on the custom swatch itself', () => {
    render(<ColorPicker value="#123456" onChange={() => {}} />)
    expect(screen.getByLabelText('Custom color')).toHaveStyle({ background: '#123456' })
    // …and the native input opens on that color rather than a stock grey.
    expect(screen.getByLabelText('Pick a custom color')).toHaveValue('#123456')
  })
})
