import { describe, it, expect } from 'vitest'
import { formatShareList, type ShareListItem } from './share-list'

const item = (name: string, quantity: string | null, aisle: string, checked = false): ShareListItem => ({
  name,
  quantity,
  aisle,
  checked,
})

describe('formatShareList', () => {
  it('groups unchecked items by aisle in board order, with quantities in parens', () => {
    const text = formatShareList([
      item('Milk', '1 gal', 'Dairy & Chilled'),
      item('Asparagus', '2 bunch', 'Produce'),
      item('Tomatoes', '2', 'Produce'),
    ])
    expect(text).toBe(
      ['PRODUCE', '- Asparagus (2 bunch)', '- Tomatoes (2)', '', 'DAIRY & CHILLED', '- Milk (1 gal)'].join('\n')
    )
  })

  it('omits the parens when an item has no quantity', () => {
    expect(formatShareList([item('Bread', null, 'Bakery')])).toBe('BAKERY\n- Bread')
  })

  it('excludes checked items entirely', () => {
    const text = formatShareList([
      item('Asparagus', '2 bunch', 'Produce'),
      item('Butter', null, 'Dairy & Chilled', true),
    ])
    expect(text).toBe('PRODUCE\n- Asparagus (2 bunch)')
  })

  it('files aisle-less items under OTHER', () => {
    const text = formatShareList([
      item('Cookies', null, ''),
      item('Asparagus', '2 bunch', 'Produce'),
    ])
    expect(text).toBe(['PRODUCE', '- Asparagus (2 bunch)', '', 'OTHER', '- Cookies'].join('\n'))
  })

  it('appends unknown aisles after the known board order', () => {
    const text = formatShareList([
      item('Charcoal', null, 'Seasonal'),
      item('Asparagus', null, 'Produce'),
    ])
    expect(text).toBe(['PRODUCE', '- Asparagus', '', 'SEASONAL', '- Charcoal'].join('\n'))
  })

  it('returns an empty string when everything is checked', () => {
    expect(formatShareList([item('Butter', null, 'Dairy & Chilled', true)])).toBe('')
  })
})
