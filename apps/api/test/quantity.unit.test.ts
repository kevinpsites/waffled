import { describe, it, expect } from 'vitest'
import { formatAmount, normalizeQuantity, parseQuantity, plainQuantity } from '../src/modules/lists/quantity'
import { mergeQuantity } from '../src/modules/lists/lists.service'

// Recipe amounts are stored as numbers, so a "⅔ cup" ingredient round-trips out of the
// parser as 0.6666666666666666. Rendering that straight into the grocery list's quantity
// text produced "0.6666666666666666 cup" on the board — the number the machine kept,
// not the one the cook wrote.
describe('formatAmount', () => {
  it('renders the common fractions as glyphs', () => {
    expect(formatAmount(2 / 3)).toBe('⅔')
    expect(formatAmount(1 / 3)).toBe('⅓')
    expect(formatAmount(0.5)).toBe('½')
    expect(formatAmount(0.25)).toBe('¼')
    expect(formatAmount(0.75)).toBe('¾')
  })

  it('renders mixed numbers with the whole part in front', () => {
    expect(formatAmount(1.5)).toBe('1½')
    expect(formatAmount(2.25)).toBe('2¼')
    expect(formatAmount(1 + 2 / 3)).toBe('1⅔')
  })

  it('leaves whole numbers and uncommon fractions readable', () => {
    expect(formatAmount(2)).toBe('2')
    expect(formatAmount(12)).toBe('12')
    expect(formatAmount(0.42)).toBe('0.42')
    expect(formatAmount(1.1)).toBe('1.1')
  })
})

describe('parseQuantity', () => {
  it('reads back what formatAmount writes, so quantities still merge', () => {
    expect(parseQuantity('⅔ cup').n).toBeCloseTo(2 / 3, 4)
    expect(parseQuantity('⅔ cup').unit).toBe('cup')
    expect(parseQuantity('1½ lb').n).toBeCloseTo(1.5, 4)
    expect(parseQuantity('2 cups').n).toBe(2)
    expect(parseQuantity('1/4 tsp').n).toBeCloseTo(0.25, 4)
  })
})

describe('normalizeQuantity', () => {
  it('turns a machine-generated decimal into the fraction a cook reads', () => {
    expect(normalizeQuantity('0.6666666666666666 cup')).toBe('⅔ cup')
    expect(normalizeQuantity('1.5 lb')).toBe('1½ lb')
    expect(normalizeQuantity('0.25')).toBe('¼')
  })

  it('leaves already-clean quantities untouched', () => {
    expect(normalizeQuantity('12')).toBe('12')
    expect(normalizeQuantity('3 cloves')).toBe('3 cloves')
    expect(normalizeQuantity('⅔ cup')).toBe('⅔ cup')
  })

  // The column is free text a person can type into, and mergeQuantity concatenates when
  // units differ. Anything that doesn't parse cleanly has to survive byte-identical —
  // a greedy parse would turn "1-2 cups" into "1 -2 cups".
  it('passes through anything it cannot parse cleanly', () => {
    expect(normalizeQuantity('1 cup + 2 tbsp')).toBe('1 cup + 2 tbsp')
    expect(normalizeQuantity('1-2 cups')).toBe('1-2 cups')
    expect(normalizeQuantity('a pinch')).toBe('a pinch')
    expect(normalizeQuantity('2 x 400g tins')).toBe('2 x 400g tins')
    expect(normalizeQuantity(null)).toBe(null)
    expect(normalizeQuantity('')).toBe('')
  })
})

// "½" is the right thing to READ and the wrong thing to have sitting in a text box —
// there is no key for it. The editor is handed an ASCII form instead, and whatever the
// person types back parses to the same number.
describe('plainQuantity (what goes in the edit box)', () => {
  it('spells fraction glyphs out with characters a keyboard has', () => {
    expect(plainQuantity('⅔ cup')).toBe('2/3 cup')
    expect(plainQuantity('1½ lb')).toBe('1 1/2 lb')
    expect(plainQuantity('¼')).toBe('1/4')
    expect(plainQuantity('2¾ cups')).toBe('2 3/4 cups')
  })

  it('leaves anything without a glyph exactly as it is', () => {
    expect(plainQuantity('2 cups')).toBe('2 cups')
    expect(plainQuantity('a pinch')).toBe('a pinch')
    expect(plainQuantity('1 cup + 2 tbsp')).toBe('1 cup + 2 tbsp')
    expect(plainQuantity(null)).toBe(null)
  })
})

describe('typed fractions round-trip', () => {
  it('parses the mixed fraction the edit box now shows', () => {
    expect(parseQuantity('1 1/2 lb').n).toBeCloseTo(1.5, 4)
    expect(parseQuantity('1 1/2 lb').unit).toBe('lb')
    expect(parseQuantity('2 3/4 cups').n).toBeCloseTo(2.75, 4)
  })

  it('normalizes what someone types back into the display form', () => {
    expect(normalizeQuantity('1 1/2 lb')).toBe('1½ lb')
    expect(normalizeQuantity('2/3 cup')).toBe('⅔ cup')
    expect(normalizeQuantity('0.5 cup')).toBe('½ cup')
    // edit box → save → edit box again lands on the same text
    expect(plainQuantity(normalizeQuantity('1 1/2 lb'))).toBe('1 1/2 lb')
  })
})

describe('mergeQuantity with fractions', () => {
  it('adds fraction quantities instead of concatenating them', () => {
    expect(mergeQuantity('⅔ cup', '⅓ cup')).toBe('1 cup')
    expect(mergeQuantity('½ cup', '½ cup')).toBe('1 cup')
    expect(mergeQuantity('1½ lb', '½ lb')).toBe('2 lb')
  })

  it('still keeps both when the units differ', () => {
    expect(mergeQuantity('1 cup', '2 tbsp')).toBe('1 cup + 2 tbsp')
  })
})
