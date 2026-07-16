// Capture Tier 2 — shared candidate ranking. Turns a free-text noun phrase
// ("the trash chore", "my reading goal") into a ranked list of existing rows with a
// confidence each, so a module resolver can drive the 0/1/many pick-one fork. This
// generalizes matchListStrict's token-overlap scoring (capture.ts) from a single
// best-match into a *ranked* list. It imports nothing from feature modules — every
// resolver builds its rows via its own list query and hands them here.

export interface RankRow {
  id: string
  title: string
  subtitle?: string
  keywords?: string[]
}

export interface Candidate {
  id: string
  title: string
  subtitle?: string
  confidence: number
  meta?: Record<string, unknown>
}

// Rows scoring below this are noise — dropped so a stray single-word overlap in a
// long phrase doesn't surface as a "match".
const FLOOR = 0.15

// Filler words dropped before matching (a generalization of matchListStrict's
// normList stopwords — kept module-agnostic, so no "list"/"chore" domain words).
const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'to', 'for'])

// lowercase → strip punctuation → drop filler → the meaningful tokens.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
}

function normalize(s: string): string {
  return tokenize(s).join(' ')
}

// Rank `rows` against a free-text `description`, sorted descending by confidence
// (0..1). An exact normalized title match scores 1.0; otherwise confidence is the
// token overlap = shared tokens / description tokens (title tokens ∪ any keywords).
// Rows below the floor are dropped; a description with no usable tokens yields [].
export function rankCandidates(description: string, rows: RankRow[]): Candidate[] {
  const descNorm = normalize(description)
  const descTokens = new Set(tokenize(description))
  if (descTokens.size === 0) return []

  const out: Candidate[] = []
  for (const row of rows) {
    const titleNorm = normalize(row.title)
    let confidence: number
    if (titleNorm && titleNorm === descNorm) {
      confidence = 1
    } else {
      const rowTokens = new Set(tokenize(row.title))
      for (const kw of row.keywords ?? []) for (const t of tokenize(kw)) rowTokens.add(t)
      let shared = 0
      for (const t of descTokens) if (rowTokens.has(t)) shared++
      confidence = shared / descTokens.size
    }
    if (confidence >= FLOOR) {
      const candidate: Candidate = { id: row.id, title: row.title, confidence }
      if (row.subtitle !== undefined) candidate.subtitle = row.subtitle
      out.push(candidate)
    }
  }
  // Stable sort (modern V8) keeps input order among equal-confidence ties.
  out.sort((a, b) => b.confidence - a.confidence)
  return out
}
