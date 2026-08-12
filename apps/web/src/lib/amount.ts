// Ingredient amounts are stored as numbers, so "⅔ cup" comes back as 0.666…. The recipe
// screens render them the way a recipe is actually written. This used to be copy-pasted
// into every screen that showed an amount; keep it here so the grocery picker and the
// recipe page behind it can't drift into disagreeing about the same ingredient.
const FRAC: Record<string, string> = { '0.5': '½', '0.25': '¼', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' }

// The other direction: a typed/pasted quantity → the number we store. Recipes are
// written in fractions ("1/2", "1 1/2", "½"), and a plain `Number()` turns every one
// of those into NaN — which the editor then saved as null, losing the quantity with no
// warning. Anything that still isn't a number (blank, "a pinch") is null on purpose.
const UNI_FRAC: Record<string, number> = {
  '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
}

export function parseAmt(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  // "½" / "1½" / "1 ½"
  const uni = t.match(/^(\d+)?\s*([¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/)
  if (uni) return (uni[1] ? Number(uni[1]) : 0) + UNI_FRAC[uni[2]]
  // "1/2" / "1 1/2" / "1 / 2"
  const frac = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/)
  if (frac) {
    const denom = Number(frac[3])
    if (denom === 0) return null
    return (frac[1] ? Number(frac[1]) : 0) + Number(frac[2]) / denom
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function fmtAmt(n: number): string {
  const whole = Math.floor(n)
  const frac = +(n - whole).toFixed(2)
  const fg = FRAC[String(frac)]
  if (fg) return whole > 0 ? `${whole}${fg}` : fg
  return `${+n.toFixed(2)}`
}
