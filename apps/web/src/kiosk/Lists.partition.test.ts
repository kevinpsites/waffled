import { partitionListItems } from './Lists'
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
