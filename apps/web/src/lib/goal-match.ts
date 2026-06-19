// Smart calendar→goal suggestions (Phase B). Given an event's text + attendees,
// guess which auto-from-calendar goal it might count toward — so an untagged
// "Library trip" can offer "✨ counts toward Reading hours?". This is a SUGGESTION
// engine only: the human always confirms, nothing is auto-linked. Runs entirely
// client-side off the already-loaded goals list (offline-friendly, no round-trip).
import type { Goal } from './api'

// Words that carry no matching signal — units, fillers, and the generic nouns that
// show up in goal titles ("read 20 books" → "read","books" matter; "20","hours"
// don't). Kept deliberately small so real activity words survive.
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

// Concept nets — each is a specific activity, NOT a broad category. A goal and an
// event "share a concept" when each contains one of its keywords; that's what lets
// "Library trip" map to "Reading hours" without also matching "Visit 30 parks"
// (different concepts), even though both goals are tagged "intellectual". This is
// the key over a category bucket, which is too coarse to disambiguate.
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

// Light stem so "reading"/"reads"/"read" collapse together. Crude on purpose —
// both sides run through it, so consistency matters more than linguistic accuracy.
function stem(w: string): string {
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3)
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1)
  return w
}

// Whole-word tokens (≥3 chars), stopwords + bare numbers dropped, then stemmed.
function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

// Pre-stem the concept nets once.
const CONCEPT_STEMS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(CONCEPTS).map(([k, ws]) => [k, new Set(ws.map(stem))])
)

// Which concepts a token set touches.
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

export interface GoalSuggestion {
  goal: Goal
  score: number
}

// Rank auto-from-calendar goals by how well they match the event. A shared
// goal-title word is the strongest signal (the user named the same activity); a
// shared concept is a softer nudge. Goals are filtered by the SAME participant rule
// as the manual picker: the goal's participants must be a superset of the event's
// attendees (with no attendees, any goal is eligible — attribution defaults to the
// goal's participants).
export function rankGoalSuggestions(
  title: string,
  description: string | null,
  attendeeIds: string[],
  goals: Goal[]
): GoalSuggestion[] {
  const evTokens = tokenize(`${title} ${description ?? ''}`)
  if (evTokens.size === 0) return []
  const evConcepts = conceptsOf(evTokens)

  const ranked: GoalSuggestion[] = []
  for (const g of goals) {
    if (!g.autoFromCalendar) continue
    // Participant superset rule (mirror EventModal's "Counts toward" gating).
    if (attendeeIds.length) {
      const gp = new Set(g.participants.map((p) => p.personId))
      if (!attendeeIds.every((id) => gp.has(id))) continue
    }
    const gTokens = tokenize(g.title)
    let score = 0
    for (const t of gTokens) if (evTokens.has(t)) score += 10 // shared activity word
    const gConcepts = conceptsOf(gTokens)
    for (const c of gConcepts) if (evConcepts.has(c)) score += 5 // shared concept
    if (score > 0) ranked.push({ goal: g, score })
  }
  return ranked.sort((a, b) => b.score - a.score)
}

// The single best suggestion, or null. Returns nothing when the top two tie — a
// tie means the event maps equally well to more than one goal, so guessing would
// be wrong as often as right; better to stay quiet and let the picker handle it.
export function suggestGoalForEvent(
  title: string,
  description: string | null,
  attendeeIds: string[],
  goals: Goal[]
): Goal | null {
  const ranked = rankGoalSuggestions(title, description, attendeeIds, goals)
  const best = ranked[0]
  if (!best || best.score < 5) return null
  if (ranked[1] && ranked[1].score === best.score) return null // ambiguous
  return best.goal
}
