// Canonical allergen keys, shared by the pantry (OFF normalization + household
// avoid-list) and per-person allergens. Display labels live on the web side.
export const ALLERGEN_KEYS = ['gluten', 'milk', 'soy', 'egg', 'peanut', 'tree_nut', 'fish', 'shellfish', 'sesame']

// Keep only known allergen keys from an arbitrary input, deduped.
export function cleanAllergens(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return Array.from(new Set(input.map(String).filter((a) => ALLERGEN_KEYS.includes(a))))
}
