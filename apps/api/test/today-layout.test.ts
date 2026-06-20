// Pure unit tests for the Today-layout normalization (no DB needed).
import { describe, it, expect } from 'vitest'
import { reconcileLayout, TODAY_CARDS } from '../src/modules/layout/today-layout'

const DEFAULT = [['agenda'], ['tonight', 'week'], ['chores', 'grocery']]

describe('reconcileLayout', () => {
  it('falls back to the default for null / garbage / all-unknown input', () => {
    expect(reconcileLayout(null)).toEqual(DEFAULT)
    expect(reconcileLayout('nope')).toEqual(DEFAULT)
    expect(reconcileLayout([['unknown'], ['also-bad']])).toEqual(DEFAULT)
  })

  it('always returns exactly 3 columns', () => {
    expect(reconcileLayout([['agenda']]).length).toBe(3)
    expect(reconcileLayout([['a'], ['b'], ['c'], ['d'], ['e']]).length).toBe(3)
  })

  it('keeps every card exactly once, appending any that are missing', () => {
    const out = reconcileLayout([['grocery', 'agenda']])
    expect([...out.flat()].sort()).toEqual([...TODAY_CARDS].sort())
    expect(out[0]).toEqual(['grocery', 'agenda']) // preserves given order + column
  })

  it('drops duplicate and unknown keys', () => {
    const out = reconcileLayout([['agenda', 'agenda', 'bogus'], ['agenda']])
    expect(out.flat().filter((k) => k === 'agenda').length).toBe(1)
    expect(out.flat()).not.toContain('bogus')
  })

  it('merges overflow columns (past the 3rd) into the last column', () => {
    const out = reconcileLayout([['agenda'], ['tonight'], ['week'], ['chores'], ['grocery']])
    expect(out[2]).toEqual(['week', 'chores', 'grocery'])
  })
})
