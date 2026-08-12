import { describe, it, expect } from 'vitest'
import { fmtAmt, parseAmt } from './amount'

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

// The inverse of fmtAmt: what someone types in a quantity box → the stored number.
// Plain `Number()` turns every fraction into NaN, which the recipe editor then saved
// as null — the quantity silently vanished.
describe('parseAmt', () => {
  it('reads plain numbers', () => {
    expect(parseAmt('3')).toBe(3)
    expect(parseAmt('2.5')).toBe(2.5)
    expect(parseAmt('  4  ')).toBe(4)
  })

  it('reads slash fractions and mixed numbers', () => {
    expect(parseAmt('1/2')).toBe(0.5)
    expect(parseAmt('1 1/2')).toBe(1.5)
    expect(parseAmt('3/4')).toBe(0.75)
    expect(parseAmt('2 3/4')).toBe(2.75)
    expect(parseAmt('1 / 2')).toBe(0.5)
  })

  it('reads the unicode fractions a pasted recipe carries', () => {
    expect(parseAmt('½')).toBe(0.5)
    expect(parseAmt('1½')).toBe(1.5)
    expect(parseAmt('1 ½')).toBe(1.5)
    expect(parseAmt('¼')).toBe(0.25)
    expect(parseAmt('⅔')).toBe(2 / 3)
  })

  it('is null for nothing and for things that are not amounts', () => {
    expect(parseAmt('')).toBeNull()
    expect(parseAmt('   ')).toBeNull()
    expect(parseAmt('abc')).toBeNull()
    expect(parseAmt('a/b')).toBeNull()
    expect(parseAmt('1/0')).toBeNull() // no Infinity into the database
  })

  // fmtAmt(parseAmt(x)) is what the recipe page shows after a save.
  it('round-trips through fmtAmt', () => {
    expect(fmtAmt(parseAmt('1 1/2')!)).toBe('1½')
    expect(fmtAmt(parseAmt('½')!)).toBe('½')
  })
})
