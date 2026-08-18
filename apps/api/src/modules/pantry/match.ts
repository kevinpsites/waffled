// Deterministic ingredient ↔ pantry-item name matching, shared by "Cook from your
// pantry" (cook.ts) and the general on-hand counts (on-hand.ts). No AI, no stemming,
// no plural handling ("tomato" does not match "tomatoes"): a name is reduced to
// significant tokens and matched by subset in whichever direction is smaller, so
// "ground beef" ↔ "beef, ground" and "chicken" ↔ "chicken breast" match but
// "egg" ↔ "eggplant" does not. Quantities and units are NEVER compared — this is a
// pure presence check.
//
// There is no synonym table and there never will be — but there IS one small curated
// list going the other way (MODIFIERS, below). The subset rule cannot survive without
// it: "butter" ⊂ "peanut butter" is the same shape as "chicken" ⊂ "chicken breast", so
// nothing about the tokens themselves says one narrows a food and the other replaces
// it. That list is an ANTI-synonym list — "these are different foods" — which is the
// only kind of vocabulary a dumb matcher can hold without becoming a guessing machine.
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

// Words that make something a DIFFERENT food rather than a narrower one. Every entry
// here is a word that, present on one side only, turns a subset "match" into a lie:
//   butter          vs Peanut butter   (fired on ~15 recipes at once — butter is in most)
//   evaporated milk vs Whole milk      ("whole" is a stopword, so the pantry side is {milk})
// Contrast the words we deliberately DON'T list — "frozen" peas are peas, a chicken
// "breast" is chicken — which is why this is a hand-curated list and not a rule like
// "a one-word name may not match a longer one". That rule was tried; it breaks both of
// those, because they are structurally identical to the pairs above.
//
// Entries must be things tokens() can actually emit: lowercase, ≥ 3 chars, no
// punctuation. That is why "non-dairy" is not here — tokens() flattens the hyphen, so
// the literal string could never match — and `dairy` stands in for it, catching
// "non-dairy" and "dairy-free" alike.
//
// KNOWN AND ACCEPTED LIMIT: "Rice" still matches "Rice vinegar", because `rice` is on
// both sides and `vinegar` is not a listed modifier. Chasing that means listing every
// noun that can follow a grain, which is a synonym table by another name. Left alone.
export const MODIFIERS = new Set([
  'peanut', 'almond', 'cashew', 'coconut', 'soy', 'oat', 'hemp', 'vegan', 'dairy',
  'evaporated', 'condensed', 'sweetened',
])

// True when one token set is a (non-empty) subset of the other, and the extra words on
// the bigger side don't change what the food IS.
export function matches(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (!big.has(t)) return false
  // Small/big come from set SIZE, not argument position, so this is symmetric: it does
  // not matter whether the modifier arrived as the ingredient or as the pantry row. A
  // listed word only disqualifies when it is the DIFFERENCE between the two names —
  // "Peanut butter" ↔ "Peanut butter" has `peanut` on both sides and still matches.
  for (const t of big) if (!small.has(t) && MODIFIERS.has(t)) return false
  return true
}
