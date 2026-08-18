// Deterministic ingredient ↔ pantry-item name matching, shared by "Cook from your
// pantry" (cook.ts) and the general on-hand counts (on-hand.ts). No AI, no stemming,
// no synonyms, no plural handling ("tomato" does not match "tomatoes"): a name is
// reduced to significant tokens and matched by subset in whichever direction is
// smaller, so "ground beef" ↔ "beef, ground" and "chicken" ↔ "chicken breast" match
// but "egg" ↔ "eggplant" does not. Quantities and units are NEVER compared — this is
// a pure presence check.
const STOPWORDS = new Set(['and', 'the', 'with', 'for', 'fresh', 'large', 'small', 'whole', 'ground'])

// A trailing allergen warning, as meal-kit imports write it:
//   "Cream cheese — contains milk"   "flour — contains gluten/wheat"   "butter (contains milk)"
// Those words describe what's IN the thing, not what the thing IS, so leaving them in
// wrecks a subset matcher: "Cream cheese — contains milk" reduces to {cream, cheese,
// contains, milk}, which a pantry carton of {milk} is a subset of — and the household
// gets told it already has cream cheese. Stripping only ever REMOVES tokens, so it can
// only remove matches, and every match it removes was one of these false ones.
// Must run on the raw name: tokens() flattens punctuation to spaces, so after that step
// there is no dash left to anchor on.
const ALLERGEN_NOTE = /\s*[—–\-,(]+\s*(?:may\s+)?contains?\b.*$/i

export function stripAllergenNote(name: string): string {
  // A name that is *only* the note ("contains milk") keeps its words — matching nothing
  // at all is a worse answer than matching oddly, and it would be invisible.
  return name.replace(ALLERGEN_NOTE, '').trim() || name
}

// Significant tokens of a name (lowercased words, length ≥ 3, minus stopwords).
// `ground` is a stopword on its own but kept as part of multi-word matches via subset.
export function tokens(name: string): Set<string> {
  return new Set(
    stripAllergenNote(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )
}

// True when one token set is a (non-empty) subset of the other.
export function matches(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (!big.has(t)) return false
  return true
}
