// Pure unit tests for the Today-layout normalization (no DB needed).
import { describe, it, expect } from 'vitest'
import { reconcileLayout, TODAY_CARDS } from '../src/modules/layout/today-layout'
import { reconcileMobileLayout, MOBILE_TODAY_CARDS } from '../src/modules/layout/mobile-today-layout'

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
    // cols past the 3rd merge in; unplaced cards (countdowns, lists, pantry, familyNight,
    // goals, rhythms — in TODAY_CARDS order) are appended to the last column.
    expect(out.cols[2]).toEqual(['week', 'chores', 'grocery', 'countdowns', 'lists', 'pantry', 'familyNight', 'goals', 'rhythms'])
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

// The rhythms card is registered here in phase 1 rather than alongside the card UI: the
// web card and the iOS card get built in parallel, and both would be adding this same key
// to these same two lines. Landing it once up front is what keeps them from conflicting.
describe('the rhythms card', () => {
  it('is a canonical card on the kiosk grid', () => {
    expect(TODAY_CARDS).toContain('rhythms')
  })

  it('is a canonical card on mobile Today', () => {
    expect(MOBILE_TODAY_CARDS).toContain('rhythms')
  })

  it('survives both reconcilers instead of being dropped as an unknown key', () => {
    expect(reconcileLayout([['rhythms', 'agenda'], [], []]).cols[0]).toEqual(['rhythms', 'agenda'])
    expect(reconcileMobileLayout({ order: ['rhythms'], hidden: [] }).order[0]).toBe('rhythms')
  })

  it('stays hidden on either surface once hidden', () => {
    // The two surfaces model "hidden" differently: web drops the card out of `cols`
    // entirely, while mobile keeps every card in `order` and flags it in `hidden`.
    expect(reconcileLayout({ cols: [[], [], []], hidden: ['rhythms'] }).cols.flat()).not.toContain('rhythms')
    expect(reconcileMobileLayout({ order: [], hidden: ['rhythms'] }).hidden).toContain('rhythms')
  })
})
