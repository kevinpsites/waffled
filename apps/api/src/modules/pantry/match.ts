// Deterministic ingredient ↔ pantry-item name matching, shared by "Cook from your
// pantry" (cook.ts) and the general on-hand counts (on-hand.ts). No AI, no stemming,
// no synonyms, no plural handling ("tomato" does not match "tomatoes"): a name is
// reduced to significant tokens and matched by subset in whichever direction is
// smaller, so "ground beef" ↔ "beef, ground" and "chicken" ↔ "chicken breast" match
// but "egg" ↔ "eggplant" does not. Quantities and units are NEVER compared — this is
// a pure presence check.
const STOPWORDS = new Set(['and', 'the', 'with', 'for', 'fresh', 'large', 'small', 'whole', 'ground'])

// Significant tokens of a name (lowercased words, length ≥ 3, minus stopwords).
// `ground` is a stopword on its own but kept as part of multi-word matches via subset.
export function tokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )
}

// True when one token set is a (non-empty) subset of the other.
export function matches(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (!big.has(t)) return false
  return true
}
