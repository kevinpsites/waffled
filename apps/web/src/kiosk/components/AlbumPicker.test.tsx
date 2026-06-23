import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { AlbumPicker } from './AlbumPicker'

// A controlled harness so we can read back what AlbumPicker reports via onChange.
function Harness({ initial = '', albums = ['Lake Day', 'Birthday'] }: { initial?: string; albums?: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <div data-testid="value">{value}</div>
      <AlbumPicker value={value} onChange={setValue} albums={albums} />
    </>
  )
}

describe('AlbumPicker', () => {
  it('lists existing albums + (No album) + ＋ New album…', () => {
    render(<Harness />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    const opts = Array.from(select.options).map((o) => o.text)
    expect(opts).toEqual(['(No album)', 'Lake Day', 'Birthday', '＋ New album…'])
  })

  it('selecting an existing album reports it', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Lake Day' } })
    expect(screen.getByTestId('value')).toHaveTextContent('Lake Day')
    // no text input while an existing album is selected
    expect(screen.queryByPlaceholderText('New album name')).not.toBeInTheDocument()
  })

  it('(No album) reports an empty value', () => {
    render(<Harness initial="Lake Day" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(screen.getByTestId('value')).toHaveTextContent('')
  })

  it('＋ New album… reveals a text input that reports typed names', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__new__' } })
    const input = screen.getByPlaceholderText('New album name')
    fireEvent.change(input, { target: { value: 'Beach Trip' } })
    expect(screen.getByTestId('value')).toHaveTextContent('Beach Trip')
  })

  it('shows the text input when value is an unknown album', () => {
    render(<Harness initial="Ski Trip" />)
    expect((screen.getByPlaceholderText('New album name') as HTMLInputElement).value).toBe('Ski Trip')
  })
})
