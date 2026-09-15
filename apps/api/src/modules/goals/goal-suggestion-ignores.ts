// Per-goal ignored words for calendar suggestions (goal_suggestion_ignores). A dismissal
// hides one event; an ignored word hides every event whose title contains it, for that
// goal only — generated series (a weekly reminder) come back as a new event each time.
import { query } from '../../platform/db'
import { ignoreWordsOf, tokensOf } from './goal-match'

// goalId -> ignored stems, loaded once per suggestions pass.
export type Ignores = Map<string, Set<string>>

export async function loadIgnores(householdId: string): Promise<Ignores> {
  const { rows } = await query<{ goal_id: string; token: string }>(
    `select goal_id, token from goal_suggestion_ignores where household_id = $1`,
    [householdId]
  )
  const out: Ignores = new Map()
  for (const r of rows) {
    let set = out.get(r.goal_id)
    if (!set) out.set(r.goal_id, (set = new Set()))
    set.add(r.token)
  }
  return out
}

export function isIgnored(title: string, goalId: string, ignores: Ignores): boolean {
  const blocked = ignores.get(goalId)
  if (!blocked) return false
  return tokensOf(title).some((t) => blocked.has(t))
}

// The picked words, normalised the way the matcher sees them; stopwords and numbers
// can never match, so they are dropped rather than stored.
export function usableIgnoreWords(words: unknown): string[] {
  if (!Array.isArray(words)) return []
  const out: string[] = []
  for (const w of words) {
    if (typeof w !== 'string') continue
    for (const word of ignoreWordsOf(w)) if (!out.includes(word)) out.push(word)
  }
  return out
}

export async function addIgnores(householdId: string, goalId: string, words: string[], personId: string | null): Promise<void> {
  for (const word of words) {
    const token = tokensOf(word)[0]
    if (!token) continue
    await query(
      `insert into goal_suggestion_ignores (household_id, goal_id, word, token, created_by)
       values ($1,$2,$3,$4,$5) on conflict (goal_id, token) do nothing`,
      [householdId, goalId, word, token, personId]
    )
  }
}

export interface IgnoreGroup {
  goalId: string
  goalTitle: string
  goalEmoji: string | null
  words: string[]
}

export async function loadIgnoresGrouped(householdId: string): Promise<IgnoreGroup[]> {
  const { rows } = await query<{ goal_id: string; title: string; emoji: string | null; word: string }>(
    `select i.goal_id, g.title, g.emoji, i.word
       from goal_suggestion_ignores i
       join goals g on g.id = i.goal_id and g.deleted_at is null
      where i.household_id = $1
      order by g.title asc, i.word asc`,
    [householdId]
  )
  const byGoal = new Map<string, IgnoreGroup>()
  for (const r of rows) {
    let grp = byGoal.get(r.goal_id)
    if (!grp) byGoal.set(r.goal_id, (grp = { goalId: r.goal_id, goalTitle: r.title, goalEmoji: r.emoji, words: [] }))
    grp.words.push(r.word)
  }
  return [...byGoal.values()]
}

export async function removeIgnore(householdId: string, goalId: string, word: string): Promise<void> {
  const token = tokensOf(word)[0]
  if (!token) return
  await query(`delete from goal_suggestion_ignores where household_id = $1 and goal_id = $2 and token = $3`, [householdId, goalId, token])
}
