import { filterListItems } from './list-search'
import type { ListItem } from '../../lib/api'

const item = (
  id: string,
  name: string,
  extra: Partial<ListItem & { aisle: string }> = {}
): ListItem & { aisle?: string } => ({
  id, name, quantity: null, checked: false, checkedAt: null, section: null, sortOrder: 0, assignee: null,
  ...extra,
})

// The fields a search matches are the fields the row shows: its name, whatever
// header it sits under (a custom list's section, a grocery row's aisle), its
// quantity, and — on a grocery row — the store it's tagged with.
describe('filterListItems', () => {
  const items = [
    item('a', 'Swimsuits', { section: 'Clothes', quantity: '×4' }),
    item('b', 'Sunscreen', { section: 'Gear' }),
    item('c', 'Bug spray', { quantity: '2 cans' }),
    item('d', 'Tomatoes', { aisle: 'Produce', store: 'Costco' }),
  ]

  it('returns every item for an empty or whitespace-only query', () => {
    expect(filterListItems(items, '').map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterListItems(items, '   ').map((i) => i.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('matches on the item name, case-insensitively', () => {
    expect(filterListItems(items, 'SWIM').map((i) => i.id)).toEqual(['a'])
  })

  it('matches on the section name', () => {
    expect(filterListItems(items, 'gear').map((i) => i.id)).toEqual(['b'])
  })

  it('matches on the quantity', () => {
    expect(filterListItems(items, 'cans').map((i) => i.id)).toEqual(['c'])
  })

  it("matches a grocery row's aisle and store", () => {
    expect(filterListItems(items, 'produce').map((i) => i.id)).toEqual(['d'])
    expect(filterListItems(items, 'costco').map((i) => i.id)).toEqual(['d'])
  })

  it('drops items that match nothing', () => {
    expect(filterListItems(items, 'kayak')).toEqual([])
  })
})
