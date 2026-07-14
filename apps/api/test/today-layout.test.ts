// Pure unit tests for the Today-layout normalization (no DB needed).
import { describe, it, expect } from 'vitest'
import { reconcileLayout, TODAY_CARDS } from '../src/modules/layout/today-layout'

const DEFAULT = [['agenda', 'countdowns'], ['tonight', 'week'], ['chores', 'grocery']]

describe('reconcileLayout', () => {
  it('falls back to the default for null / garbage / all-unknown input', () => {
    expect(reconcileLayout(null)).toEqual({ cols: DEFAULT, hidden: [] })
    expect(reconcileLayout('nope')).toEqual({ cols: DEFAULT, hidden: [] })
    expect(reconcileLayout([['unknown'], ['also-bad']])).toEqual({ cols: DEFAULT, hidden: [] })
  })

  it('always returns exactly 3 columns', () => {
    expect(reconcileLayout([['agenda']]).cols.length).toBe(3)
    expect(reconcileLayout([['a'], ['b'], ['c'], ['d'], ['e']]).cols.length).toBe(3)
  })

  it('keeps every card exactly once, appending any that are missing', () => {
    const out = reconcileLayout([['grocery', 'agenda']])
    expect([...out.cols.flat()].sort()).toEqual([...TODAY_CARDS].sort())
    expect(out.cols[0]).toEqual(['grocery', 'agenda']) // preserves given order + column
  })

  it('drops duplicate and unknown keys', () => {
    const out = reconcileLayout([['agenda', 'agenda', 'bogus'], ['agenda']])
    expect(out.cols.flat().filter((k) => k === 'agenda').length).toBe(1)
    expect(out.cols.flat()).not.toContain('bogus')
  })

  it('merges overflow columns (past the 3rd) into the last column', () => {
    const out = reconcileLayout([['agenda'], ['tonight'], ['week'], ['chores'], ['grocery']])
    // cols past the 3rd merge in; unplaced cards (countdowns, pantry, familyNight, goals — in
    // TODAY_CARDS order) are appended to the last column.
    expect(out.cols[2]).toEqual(['week', 'chores', 'grocery', 'countdowns', 'pantry', 'familyNight', 'goals'])
  })

  // --- Hidden cards -------------------------------------------------------

  it('accepts the {cols, hidden} shape and keeps hidden cards out of the columns', () => {
    const out = reconcileLayout({ cols: [['agenda'], [], []], hidden: ['grocery', 'chores'] })
    expect(out.hidden.sort()).toEqual(['chores', 'grocery'])
    expect(out.cols.flat()).not.toContain('grocery')
    expect(out.cols.flat()).not.toContain('chores')
  })

  it('does not re-append a hidden card as "missing"', () => {
    // grocery is hidden and absent from cols — it must NOT come back via the missing-append pass.
    const out = reconcileLayout({ cols: [['agenda', 'countdowns'], ['tonight', 'week'], ['chores']], hidden: ['grocery'] })
    expect(out.cols.flat()).not.toContain('grocery')
    expect(out.hidden).toEqual(['grocery'])
  })

  it('drops a card from the columns if it is also listed as hidden (hidden wins)', () => {
    const out = reconcileLayout({ cols: [['agenda', 'grocery'], [], []], hidden: ['grocery'] })
    expect(out.cols.flat()).not.toContain('grocery')
    expect(out.hidden).toEqual(['grocery'])
  })

  it('dedupes and drops unknown/invalid hidden keys', () => {
    const out = reconcileLayout({ cols: [['agenda'], [], []], hidden: ['grocery', 'grocery', 'bogus', 42] })
    expect(out.hidden).toEqual(['grocery'])
  })

  it('does not fall back to default when everything is hidden (empty cols + hidden set)', () => {
    const out = reconcileLayout({ cols: [[], [], []], hidden: [...TODAY_CARDS] })
    expect(out.cols).toEqual([[], [], []])
    expect(out.hidden.sort()).toEqual([...TODAY_CARDS].sort())
  })

  it('treats a legacy bare-array layout as {cols, hidden: []}', () => {
    const out = reconcileLayout(DEFAULT)
    expect(out.hidden).toEqual([])
    expect(out.cols[0]).toEqual(['agenda', 'countdowns']) // given columns preserved
    expect([...out.cols.flat()].sort()).toEqual([...TODAY_CARDS].sort()) // module cards appended
  })
})
