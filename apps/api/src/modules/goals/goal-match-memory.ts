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

// Best learned match for an event's title among the eligible goals, or null. Sums
// learned token weights per goal; needs a clear winner (≥4 ≈ one human signal, and
// strictly ahead of the runner-up) so a single weak hint never overrides keywords.
export function memoryMatch(title: string, eligibleGoalIds: Set<string>, mem: Memory): string | null {
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
  return best.id
}
