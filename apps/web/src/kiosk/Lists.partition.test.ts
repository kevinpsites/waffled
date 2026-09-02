import { partitionListItems, groupBySection, filterListItems } from './Lists'
import type { ListItem } from '../lib/api'

const item = (id: string, checked: boolean): ListItem => ({
  id,
  name: id,
  quantity: null,
  checked,
  checkedAt: checked ? '2026-05-31T00:00:00Z' : null,
  section: 'Clothes',
  sortOrder: 0,
  assignee: null,
})

describe('partitionListItems', () => {
  it('sorts checked items into completed and unchecked into active', () => {
    const { active, completed } = partitionListItems(
      [item('a', false), item('b', true), item('c', false)],
      new Set()
    )
    expect(active.map((i) => i.id)).toEqual(['a', 'c'])
    expect(completed.map((i) => i.id)).toEqual(['b'])
  })

  it('keeps a just-checked (recent) item in active as an undo grace window', () => {
    const { active, completed } = partitionListItems([item('b', true)], new Set(['b']))
    expect(active.map((i) => i.id)).toEqual(['b'])
    expect(completed).toEqual([])
  })
})

describe('groupBySection', () => {
  const it_ = (id: string, section: string | null): ListItem => ({
    id, name: id, quantity: null, checked: false, checkedAt: null, section, sortOrder: 0, assignee: null,
  })

  it('orders sections A–Z regardless of item order, with no-section "Items" last', () => {
    // Items arrive in a deliberately non-alphabetical section order.
    const groups = groupBySection([
      it_('g', 'Gear'), it_('a', 'Apples'), it_('n', null), it_('c', 'Clothes'), it_('g2', 'Gear'),
    ])
    expect(groups.map((g) => g.title)).toEqual(['Apples', 'Clothes', 'Gear', 'Items'])
  })

  it('sorts case-insensitively and keeps item order within a section', () => {
    const groups = groupBySection([it_('b', 'beta'), it_('A', 'Alpha'), it_('b2', 'beta')])
    expect(groups.map((g) => g.title)).toEqual(['Alpha', 'beta'])
    expect(groups[1].items.map((i) => i.id)).toEqual(['b', 'b2'])
  })
})

// Free-text search over a list — same three fields iOS matches on (name, section,
// quantity) so a search means the same thing on both platforms.
describe('filterListItems', () => {
  const it_ = (id: string, name: string, section: string | null, quantity: string | null): ListItem => ({
    id, name, quantity, checked: false, checkedAt: null, section, sortOrder: 0, assignee: null,
  })
  const items = [
    it_('a', 'Swimsuits', 'Clothes', '×4'),
    it_('b', 'Sunscreen', 'Gear', null),
    it_('c', 'Bug spray', null, '2 cans'),
  ]

  it('returns every item for an empty or whitespace-only query', () => {
    expect(filterListItems(items, '').map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(filterListItems(items, '   ').map((i) => i.id)).toEqual(['a', 'b', 'c'])
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

  it('drops items that match nothing', () => {
    expect(filterListItems(items, 'kayak')).toEqual([])
  })
})
