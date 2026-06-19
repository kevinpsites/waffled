// Server-side concept matcher for smart calendar→goal suggestions (Phase B). This
// MIRRORS apps/web/src/lib/goal-match.ts — keep the CONCEPTS map + scoring in sync.
// The web copy powers the instant in-modal suggestion (offline); this copy powers
// the batched Today suggestions surface (and is the keyword pass an LLM falls back
// after). Matching on specific CONCEPTS (reading/outdoors/…), NOT a goal's coarse
// category, is what lets "Library trip" map to Reading without also hitting a parks
// goal tagged the same category.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'my', 'our', 'at',
  'goal', 'goals', 'challenge', 'daily', 'weekly', 'monthly', 'total', 'count',
  'hour', 'hours', 'hr', 'hrs', 'minute', 'minutes', 'min', 'mins', 'day', 'days',
  'time', 'times', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'session', 'appointment', 'appt', 'meeting', 'event', 'reminder', 'state',
  // Generic scheduling/time words — pure noise, and a couple ('booking') would
  // mis-stem into real activity words ('book').
  'morning', 'afternoon', 'evening', 'tonight', 'today', 'tomorrow', 'weekend', 'booking', 'class',
])

const CONCEPTS: Record<string, string[]> = {
  reading: ['read', 'reading', 'book', 'books', 'library', 'novel', 'story', 'stories', 'literacy', 'audiobook'],
  running: ['run', 'running', 'jog', 'jogging', 'marathon', 'sprint', '5k', '10k'],
  walking: ['walk', 'walking', 'steps', 'stroll'],
  hiking: ['hike', 'hiking', 'trail', 'trek', 'trekking'],
  cycling: ['bike', 'biking', 'cycle', 'cycling', 'spin'],
  swimming: ['swim', 'swimming', 'laps', 'pool'],
  outdoors: [
    'outside', 'outdoor', 'outdoors', 'park', 'parks', 'nature', 'camping', 'camp', 'fresh',
    'mow', 'mowing', 'lawn', 'grass', 'rake', 'raking', 'leaves', 'yard', 'yardwork',
    'shovel', 'shoveling', 'mulch', 'picnic', 'playground', 'beach', 'fishing', 'kayak', 'canoe',
  ],
  sports: ['soccer', 'basketball', 'baseball', 'football', 'tennis', 'hockey', 'volleyball', 'golf', 'practice', 'match', 'league', 'scrimmage', 'tournament'],
  gym: ['gym', 'workout', 'exercise', 'fitness', 'lifting', 'crossfit', 'strength', 'cardio'],
  yoga: ['yoga', 'pilates', 'stretch', 'stretching'],
  dance: ['dance', 'dancing', 'ballet'],
  music: ['music', 'piano', 'guitar', 'ukulele', 'violin', 'drums', 'song', 'songs', 'instrument', 'band', 'recital', 'sing', 'singing', 'choir'],
  art: ['art', 'paint', 'painting', 'draw', 'drawing', 'sketch', 'craft', 'crafts', 'pottery', 'sculpt'],
  writing: ['write', 'writing', 'journal', 'journaling', 'essay', 'blog', 'poem', 'poetry'],
  cooking: ['cook', 'cooking', 'bake', 'baking', 'recipe', 'meal', 'meals'],
  meditation: ['meditate', 'meditation', 'mindfulness', 'breathe', 'breathing'],
  faith: ['pray', 'prayer', 'church', 'mass', 'worship', 'bible', 'temple', 'mosque', 'synagogue', 'devotion', 'scripture'],
  language: ['language', 'spanish', 'french', 'german', 'mandarin', 'duolingo', 'vocab', 'vocabulary'],
  chores: ['clean', 'cleaning', 'laundry', 'dishes', 'tidy', 'tidying', 'chore', 'chores', 'vacuum', 'declutter', 'sweep', 'sweeping', 'mop', 'mopping'],
  garden: ['garden', 'gardening', 'plant', 'planting', 'weeding', 'yard'],
  social: ['visit', 'party', 'playdate', 'hangout', 'reunion', 'gathering', 'volunteer', 'volunteering'],
}

function stem(w: string): string {
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3)
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1)
  return w
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

// The meaningful, stemmed tokens of a string — the unit the learning cache keys
// on (so "Mowing the grass" teaches mow→goal, grass→goal for the household).
export function tokensOf(text: string): string[] {
  return [...tokenize(text)]
}

const CONCEPT_STEMS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(CONCEPTS).map(([k, ws]) => [k, new Set(ws.map(stem))])
)

function conceptsOf(tokens: Set<string>): Set<string> {
  const hit = new Set<string>()
  for (const [concept, stems] of Object.entries(CONCEPT_STEMS)) {
    for (const t of tokens) {
      if (stems.has(t)) {
        hit.add(concept)
        break
      }
    }
  }
  return hit
}

export interface MatchGoal {
  id: string
  title: string
}

// Best keyword/concept match for an event, or null (incl. on an exact tie —
// ambiguous, so stay quiet and let the LLM or the human decide). Caller is
// responsible for participant eligibility (pass only eligible goals).
export function keywordMatch(title: string, description: string | null, goals: MatchGoal[]): string | null {
  const evTokens = tokenize(`${title} ${description ?? ''}`)
  if (evTokens.size === 0) return null
  const evConcepts = conceptsOf(evTokens)

  const ranked: Array<{ id: string; score: number }> = []
  for (const g of goals) {
    const gTokens = tokenize(g.title)
    let score = 0
    for (const t of gTokens) if (evTokens.has(t)) score += 10
    for (const c of conceptsOf(gTokens)) if (evConcepts.has(c)) score += 5
    if (score > 0) ranked.push({ id: g.id, score })
  }
  ranked.sort((a, b) => b.score - a.score)
  const best = ranked[0]
  if (!best || best.score < 5) return null
  if (ranked[1] && ranked[1].score === best.score) return null
  return best.id
}
