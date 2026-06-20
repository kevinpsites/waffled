// Phase B learning cache (goal_match_memory). Per household, we accumulate
// per-token → goal weights so the matcher personalizes to how THIS family names
// things. Sources, by strength: a human linking/picking a goal (strong), the LLM
// resolving a novel phrasing (light). Suggestions consult this BEFORE the keyword
// matcher and before paying for another LLM call. See goal-match.ts for the
// stateless keyword pass this layers on top of.
import { query } from '../../platform/db'
import { tokensOf } from './goal-match'

// Weights by source. Human choice is gold-standard; an LLM guess is a softer hint.
export const WEIGHT = { human: 3, llm: 1 } as const

// Memory score at/above which the modal auto-links (pre-selects) the goal instead
// of just suggesting it. 9 ≈ the family has confirmed a phrasing ~twice (each
// human link is +3/word), so the 3rd identical event pre-fills. The recap still
// confirms before any progress is logged, so an unwanted auto-link is undo-able.
export const AUTO_LINK_THRESHOLD = 9

// Record that `title` mapped to `goalId` for this household — bump every meaningful
// token's weight toward that goal. Best-effort: never throws into the caller.
export async function recordMatch(
  householdId: string,
  title: string,
  goalId: string,
  weight: number
): Promise<void> {
  const tokens = tokensOf(title)
  if (!tokens.length || weight <= 0) return
  try {
    await Promise.all(
      tokens.map((token) =>
        query(
          `insert into goal_match_memory (household_id, token, goal_id, weight)
           values ($1,$2,$3,$4)
           on conflict (household_id, token, goal_id)
           do update set weight = goal_match_memory.weight + excluded.weight`,
          [householdId, token, goalId, weight]
        )
      )
    )
  } catch {
    /* learning is best-effort — a failed write must not break event saves */
  }
}

// token -> (goalId -> weight) for one household, loaded once for batch scoring.
export type Memory = Map<string, Map<string, number>>

export async function loadMemory(householdId: string): Promise<Memory> {
  const mem: Memory = new Map()
  const { rows } = await query<{ token: string; goal_id: string; weight: number }>(
    `select token, goal_id, weight from goal_match_memory where household_id = $1`,
    [householdId]
  )
  for (const r of rows) {
    let g = mem.get(r.token)
    if (!g) {
      g = new Map()
      mem.set(r.token, g)
    }
    g.set(r.goal_id, Number(r.weight))
  }
  return mem
}

// ── Settings: view + forget learned matches ─────────────────────────────────
export interface MemoryGroup {
  goalId: string
  goalTitle: string
  goalEmoji: string | null
  tokens: Array<{ token: string; weight: number }>
}

// Learned matches grouped by goal (for Settings → Smart matching). Skips orphaned
// rows whose goal was deleted.
export async function loadMemoryGrouped(householdId: string): Promise<MemoryGroup[]> {
  const { rows } = await query<{ goal_id: string; title: string; emoji: string | null; token: string; weight: number }>(
    `select m.goal_id, g.title, g.emoji, m.token, m.weight
       from goal_match_memory m
       join goals g on g.id = m.goal_id and g.deleted_at is null
      where m.household_id = $1
      order by g.title asc, m.weight desc, m.token asc`,
    [householdId]
  )
  const byGoal = new Map<string, MemoryGroup>()
  for (const r of rows) {
    let grp = byGoal.get(r.goal_id)
    if (!grp) {
      grp = { goalId: r.goal_id, goalTitle: r.title, goalEmoji: r.emoji, tokens: [] }
      byGoal.set(r.goal_id, grp)
    }
    grp.tokens.push({ token: r.token, weight: Number(r.weight) })
  }
  return [...byGoal.values()]
}

// Forget one learned word→goal (the ✕ on a chip), or all words for a goal when
// token is omitted.
export async function forgetMemory(householdId: string, goalId: string, token?: string | null): Promise<void> {
  if (token) {
    await query(`delete from goal_match_memory where household_id = $1 and goal_id = $2 and token = $3`, [householdId, goalId, token])
  } else {
    await query(`delete from goal_match_memory where household_id = $1 and goal_id = $2`, [householdId, goalId])
  }
}

// Wipe all learned matches for the household ("Reset learned matches").
export async function clearMemory(householdId: string): Promise<void> {
  await query(`delete from goal_match_memory where household_id = $1`, [householdId])
}

// Best learned match for an event's title among the eligible goals, with its
// score, or null. Sums learned token weights per goal; needs a clear winner (≥4 ≈
// one human signal, and strictly ahead of the runner-up) so a single weak hint
// never overrides keywords. The score drives the auto-link threshold.
export function memoryMatch(title: string, eligibleGoalIds: Set<string>, mem: Memory): { goalId: string; score: number } | null {
  if (mem.size === 0) return null
  const score = new Map<string, number>()
  for (const token of tokensOf(title)) {
    const g = mem.get(token)
    if (!g) continue
    for (const [goalId, w] of g) {
      if (!eligibleGoalIds.has(goalId)) continue
      score.set(goalId, (score.get(goalId) ?? 0) + w)
    }
  }
  let best: { id: string; w: number } | null = null
  let second = 0
  for (const [id, w] of score) {
    if (!best || w > best.w) {
      second = best?.w ?? 0
      best = { id, w }
    } else if (w > second) {
      second = w
    }
  }
  if (!best || best.w < 4 || best.w === second) return null
  return { goalId: best.id, score: best.w }
}
