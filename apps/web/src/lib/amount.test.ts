import { describe, it, expect } from 'vitest'
import { fmtAmt } from './amount'

// The recipe screens render ingredient amounts as fractions rather than decimals. This
// lived twice (RecipeView and the grocery picker) as byte-identical copies; it's shared
// now so the picker and the page behind it can never disagree about the same number.
describe('fmtAmt', () => {
  it('renders the fractions a recipe is written with', () => {
    expect(fmtAmt(0.5)).toBe('½')
    expect(fmtAmt(0.25)).toBe('¼')
    expect(fmtAmt(0.75)).toBe('¾')
    expect(fmtAmt(1 / 3)).toBe('⅓')
    expect(fmtAmt(2 / 3)).toBe('⅔')
  })

  it('puts the whole part in front of a mixed number', () => {
    expect(fmtAmt(1.5)).toBe('1½')
    expect(fmtAmt(2.25)).toBe('2¼')
  })

  it('keeps whole numbers and odd amounts readable', () => {
    expect(fmtAmt(2)).toBe('2')
    expect(fmtAmt(0.42)).toBe('0.42')
  })

  // Scaling a recipe is the reason this gets non-round inputs at all.
  it('survives a doubled or halved amount', () => {
    expect(fmtAmt(0.5 * 2)).toBe('1')
    expect(fmtAmt(1 * 0.5)).toBe('½')
    expect(fmtAmt((2 / 3) * 2)).toBe('1⅓')
  })
})
