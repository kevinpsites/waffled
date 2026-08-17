import { describe, it, expect } from 'vitest'
import { formatShareList, formatShareListMarkdown, type ShareListItem } from './share-list'

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

// The Markdown variant is the same list in a form that pastes into a notes app as
// a working checklist. It shares the grouping/ordering rules above exactly — only
// the line and header syntax differ — so these tests mirror the plain-text suite.
describe('formatShareListMarkdown', () => {
  it('renders unchecked items as open task boxes under ## headers', () => {
    const md = formatShareListMarkdown([
      item('Milk', '1 gal', 'Dairy & Chilled'),
      item('Asparagus', '2 bunch', 'Produce'),
      item('Tomatoes', '2', 'Produce'),
    ])
    expect(md).toBe(
      [
        '## Produce',
        '- [ ] Asparagus (2 bunch)',
        '- [ ] Tomatoes (2)',
        '',
        '## Dairy & Chilled',
        '- [ ] Milk (1 gal)',
      ].join('\n')
    )
  })

  it('omits the parens when an item has no quantity', () => {
    expect(formatShareListMarkdown([item('Bread', null, 'Bakery')])).toBe('## Bakery\n- [ ] Bread')
  })

  // Same rule as the plain-text share: the export is the shopping list, and a
  // checked item is already in the cart. Every emitted box is therefore unticked.
  it('excludes checked items entirely rather than emitting [x]', () => {
    const md = formatShareListMarkdown([
      item('Asparagus', '2 bunch', 'Produce'),
      item('Butter', null, 'Dairy & Chilled', true),
    ])
    expect(md).toBe('## Produce\n- [ ] Asparagus (2 bunch)')
    expect(md).not.toContain('[x]')
  })

  it('files aisle-less items under Other', () => {
    const md = formatShareListMarkdown([item('Cookies', null, ''), item('Asparagus', '2 bunch', 'Produce')])
    expect(md).toBe(['## Produce', '- [ ] Asparagus (2 bunch)', '', '## Other', '- [ ] Cookies'].join('\n'))
  })

  it('appends unknown aisles after the known board order', () => {
    const md = formatShareListMarkdown([item('Charcoal', null, 'Seasonal'), item('Asparagus', null, 'Produce')])
    expect(md).toBe(['## Produce', '- [ ] Asparagus', '', '## Seasonal', '- [ ] Charcoal'].join('\n'))
  })

  it('returns an empty string when everything is checked', () => {
    expect(formatShareListMarkdown([item('Butter', null, 'Dairy & Chilled', true)])).toBe('')
  })

  // An ungrouped custom list is a flat checklist — a lone "## Other" is noise.
  it('omits headers entirely when nothing in the list is grouped', () => {
    const md = formatShareListMarkdown([
      item('Wood screws', '1 box', ''),
      item('Sandpaper', null, ''),
      item('Wood glue', null, ''),
    ])
    expect(md).toBe(['- [ ] Wood screws (1 box)', '- [ ] Sandpaper', '- [ ] Wood glue'].join('\n'))
  })

  it('keeps the header when the single group is a real section', () => {
    expect(formatShareListMarkdown([item('Wood screws', null, 'Hardware')])).toBe('## Hardware\n- [ ] Wood screws')
  })

  it('carries store and assignee notes through unchanged', () => {
    const md = formatShareListMarkdown([
      { ...item('Whole milk', '1 gal', 'Dairy & Chilled'), store: 'Costco', assignee: 'Kelly' },
    ])
    expect(md).toBe('## Dairy & Chilled\n- [ ] Whole milk (1 gal) [Costco · Kelly]')
  })
})
