// Ingredient amounts are stored as numbers, so "⅔ cup" comes back as 0.666…. The recipe
// screens render them the way a recipe is actually written. This used to be copy-pasted
// into every screen that showed an amount; keep it here so the grocery picker and the
// recipe page behind it can't drift into disagreeing about the same ingredient.
const FRAC: Record<string, string> = { '0.5': '½', '0.25': '¼', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' }

export function fmtAmt(n: number): string {
  const whole = Math.floor(n)
  const frac = +(n - whole).toFixed(2)
  const fg = FRAC[String(frac)]
  if (fg) return whole > 0 ? `${whole}${fg}` : fg
  return `${+n.toFixed(2)}`
}
