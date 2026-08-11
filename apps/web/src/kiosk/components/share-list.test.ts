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

  // Custom lists (hardware run, packing list) often have no sections at all.
  // Filing the whole thing under a lone OTHER header is noise, not structure.
  it('omits headers entirely when nothing in the list is grouped', () => {
    const text = formatShareList([
      item('Wood screws', '1 box', ''),
      item('Sandpaper', null, ''),
      item('Wood glue', null, ''),
    ])
    expect(text).toBe(['- Wood screws (1 box)', '- Sandpaper', '- Wood glue'].join('\n'))
  })

  it('keeps the header when the single group is a real section', () => {
    const text = formatShareList([item('Wood screws', null, 'Hardware')])
    expect(text).toBe('HARDWARE\n- Wood screws')
  })

  it('still uses OTHER when some items are grouped and some are not', () => {
    const text = formatShareList([item('Wood screws', null, 'Hardware'), item('Snacks', null, '')])
    expect(text).toBe(['HARDWARE', '- Wood screws', '', 'OTHER', '- Snacks'].join('\n'))
  })

  // The two things the shopper actually needs that the plain name doesn't carry:
  // which shop it's from, and whose item it is. Both are usually unset, so they
  // only appear when the household has bothered to fill them in.
  describe('annotations', () => {
    it('notes the store when an item has one', () => {
      const text = formatShareList([{ ...item('Whole milk', '1 gal', 'Dairy & Chilled'), store: 'Costco' }])
      expect(text).toBe('DAIRY & CHILLED\n- Whole milk (1 gal) [Costco]')
    })

    it('notes who an item is for when it is assigned', () => {
      const text = formatShareList([{ ...item('Swimsuits', '×4', 'Clothes'), assignee: 'Kelly' }])
      expect(text).toBe('CLOTHES\n- Swimsuits (×4) [Kelly]')
    })

    it('lists store then person when an item has both', () => {
      const text = formatShareList([
        { ...item('Whole milk', '1 gal', 'Dairy & Chilled'), store: 'Costco', assignee: 'Kelly' },
      ])
      expect(text).toBe('DAIRY & CHILLED\n- Whole milk (1 gal) [Costco · Kelly]')
    })

    it('stays unambiguous next to an allergen note already in the name', () => {
      const text = formatShareList([
        { ...item('Shredded mozzarella — contains milk', null, 'Dairy & Chilled'), store: 'Costco' },
      ])
      expect(text).toBe('DAIRY & CHILLED\n- Shredded mozzarella — contains milk [Costco]')
    })

    it('adds nothing when neither is set (the common case)', () => {
      const text = formatShareList([{ ...item('Bananas', '1 bunch', 'Produce'), store: null, assignee: null }])
      expect(text).toBe('PRODUCE\n- Bananas (1 bunch)')
    })

    it('ignores blank strings rather than emitting empty brackets', () => {
      const text = formatShareList([{ ...item('Bananas', null, 'Produce'), store: '  ', assignee: '' }])
      expect(text).toBe('PRODUCE\n- Bananas')
    })
  })
})
