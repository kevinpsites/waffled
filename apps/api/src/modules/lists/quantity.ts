// Grocery quantities are free text ("2 cups", "a pinch", "1 cup + 2 tbsp"), but the ones
// we generate come from a recipe ingredient's numeric amount. A "⅔ cup" ingredient is
// stored as 0.6666666666666666, so writing it out raw put "0.6666666666666666 cup" on the
// board — the number the machine kept rather than the one the cook wrote. These helpers
// render amounts the way the recipe screens already do (½ ¼ ¾ ⅓ ⅔ …) and read them back,
// so a formatted quantity still merges arithmetically instead of concatenating.

const GLYPH_VALUE: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
}
// Simplest denominators first, so 0.5 renders ½ rather than ⁴⁄₈.
const GLYPHS: Array<[number, string]> = [
  [1 / 2, '½'], [1 / 3, '⅓'], [2 / 3, '⅔'], [1 / 4, '¼'], [3 / 4, '¾'],
  [1 / 5, '⅕'], [2 / 5, '⅖'], [1 / 8, '⅛'], [3 / 8, '⅜'], [5 / 8, '⅝'], [7 / 8, '⅞'],
]
const EPS = 0.005
const GLYPH_CLASS = '½⅓⅔¼¾⅕⅖⅛⅜⅝⅞'

/** Render a numeric amount the way the recipe views do: 0.6667 → "⅔", 1.5 → "1½", 2 → "2". */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `${+n.toFixed(2)}`
  const whole = Math.floor(n + 1e-9)
  const frac = n - whole
  if (frac < EPS) return String(whole)
  for (const [value, glyph] of GLYPHS) {
    if (Math.abs(frac - value) < EPS) return whole > 0 ? `${whole}${glyph}` : glyph
  }
  // not a fraction anyone writes on a shopping list — keep it as a short decimal
  return `${+n.toFixed(2)}`
}

/**
 * Split a quantity string into its leading amount and the rest ("⅔ cup" → 0.667 + "cup").
 * `n` is null when there is no leading number at all, which is how callers know to leave
 * the text alone.
 */
export function parseQuantity(q: string | null): { n: number | null; unit: string } {
  if (!q) return { n: null, unit: '' }
  const t = q.trim()
  const m = new RegExp(
    `^(\\d+\\s*[${GLYPH_CLASS}]|[${GLYPH_CLASS}]|\\d+\\s*/\\s*\\d+|\\d*\\.\\d+|\\d+)\\s*(.*)$`
  ).exec(t)
  if (!m) return { n: null, unit: t }
  const token = m[1].replace(/\s+/g, '')
  const unit = m[2].trim()

  const glyph = [...token].find((c) => GLYPH_VALUE[c] != null)
  if (glyph) {
    const wholePart = token.slice(0, token.indexOf(glyph))
    const whole = wholePart ? parseInt(wholePart, 10) : 0
    return { n: whole + GLYPH_VALUE[glyph], unit }
  }
  if (token.includes('/')) {
    const [a, b] = token.split('/').map(Number)
    return { n: b ? a / b : null, unit }
  }
  const n = parseFloat(token)
  return { n: Number.isFinite(n) ? n : null, unit }
}

// A unit is something like "cup", "cloves", "fl oz" — letters and spaces. Anything else
// (a digit, a dash, a "+") means we did NOT parse the whole amount and must not rewrite
// the text: "1-2 cups" would otherwise come back as "1 -2 cups".
const UNIT_ONLY = /^[A-Za-z][A-Za-z. ]*$/

/**
 * Tidy a quantity string for display, but only when it parses unambiguously. Free text a
 * person typed, and the "1 cup + 2 tbsp" form mergeQuantity produces when units differ,
 * pass through byte-identical.
 */
export function normalizeQuantity(q: string | null): string | null {
  if (q == null) return null
  const t = q.trim()
  if (!t) return q
  const { n, unit } = parseQuantity(t)
  if (n == null) return q
  if (unit !== '' && !UNIT_ONLY.test(unit)) return q
  return unit ? `${formatAmount(n)} ${unit}` : formatAmount(n)
}
