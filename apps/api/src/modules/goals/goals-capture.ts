// Capture Tier 2 — the 'goal' target. Turns a spoken noun phrase ("my reading goal")
// into candidate goals and applies a `log` mutation to the chosen one, reusing the
// goals module's own service fns + the shared candidate ranker. Registered into the
// capture registry from registerGoalRoutes (goals.routes.ts) so capture never touches
// goals' tables directly. Imports only from capture's leaf files (candidate-match /
// capture-resolvers, which depend on no feature module) — no import cycle.
import { query } from '../../platform/db'
import { moduleEnabled } from '../../platform/modules'
import { requireCapability } from '../../platform/permissions'
import { rankCandidates, type Candidate, type RankRow } from '../capture/candidate-match'
import {
  registerCaptureTarget,
  type CaptureTarget,
  type ResolveCtx,
  type ResolveRequest,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { conceptKeywords } from './goal-match'
import { listGoals, logProgress, isTimeUnit, personsInHousehold } from './goals.service'

// A 4xx the /commit dispatcher shapes into { error, message } (it reads statusCode).
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number }
  e.statusCode = statusCode
  return e
}

// Does the phrase say "my"/"our"/"mine"? Then scope to the speaker's own goals. The
// ranker strips these as stopwords, so we sniff the raw description before it's ranked.
function impliesMine(description: string): boolean {
  return /\b(my|mine|our)\b/i.test(description)
}

const numOr0 = (v: unknown): number => (v == null ? 0 : Number(v))

// A short progress/target line for the pick-one preview.
function goalSubtitle(g: { totalProgress: number; target: number | null; unit: string | null; goalType: string }): string {
  if (g.target != null) return `${g.totalProgress}/${g.target}${g.unit ? ` ${g.unit}` : ''}`
  return g.unit ?? g.goalType
}

// Resolve an explicit "attribute to someone else" arg to a person id (or null for the
// default self-log). Validates the id/name is a live member of this household.
async function resolveOtherPerson(ctx: ResolveCtx, args: Record<string, unknown>): Promise<string | null> {
  const pid = typeof args.personId === 'string' && args.personId.trim() ? args.personId.trim() : null
  if (pid) {
    if (!(await personsInHousehold(ctx.householdId, [pid]))) throw httpError(400, 'unknown person')
    return pid
  }
  const name = typeof args.personName === 'string' && args.personName.trim() ? args.personName.trim() : null
  if (name) {
    const { rows } = await query<{ id: string }>(
      `select id from persons where household_id=$1 and deleted_at is null and lower(name)=lower($2) limit 1`,
      [ctx.householdId, name]
    )
    if (!rows[0]) throw httpError(400, 'unknown person')
    return rows[0].id
  }
  return null
}

const goalTarget: CaptureTarget = {
  isEnabled: (ctx: ResolveCtx) => moduleEnabled(ctx.settings, 'goals'),
  disabledReason: 'Goals is turned off.',

  async resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]> {
    const goals = await listGoals(ctx.householdId)
    // Checklist goals have no numeric progress — they can't be /log'd, so never offer them.
    let rows = goals.filter((g) => g.goalType !== 'checklist')
    // "my …" → keep the speaker's own goals (participant) and unassigned family goals;
    // drop goals that belong to someone else.
    if (impliesMine(req.target.description)) {
      rows = rows.filter((g) => {
        const parts = (g.participants ?? []) as Array<{ personId: string }>
        return parts.length === 0 || parts.some((p) => p.personId === ctx.personId)
      })
    }
    const byId = new Map(rows.map((g) => [g.id, g]))
    const rankRows: RankRow[] = rows.map((g) => ({
      id: g.id,
      title: g.title,
      subtitle: goalSubtitle(g),
      keywords: conceptKeywords(g.title),
    }))
    return rankCandidates(req.target.description, rankRows).map((c) => {
      const g = byId.get(c.id)!
      return { ...c, meta: { goalType: g.goalType, unit: g.unit } }
    })
  },

  async applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }> {
    if (cmd.verb !== 'log') throw httpError(400, "Can't do that to a goal")
    const { rows } = await query<{ title: string; goal_type: string; unit: string | null }>(
      `select title, goal_type, unit from goals where household_id=$1 and id=$2 and deleted_at is null`,
      [ctx.householdId, cmd.targetId]
    )
    const goal = rows[0]
    if (!goal) throw httpError(404, 'goal not found')
    if (goal.goal_type === 'checklist') {
      throw httpError(400, 'checklist goals are updated by ticking steps, not logging progress')
    }
    const args = cmd.args ?? {}

    // Self-log is open; attributing to another person takes goal.manage (mirrors
    // the /api/goals/:id/log route). Default the credit to the speaker.
    let personIds = [ctx.personId]
    const other = await resolveOtherPerson(ctx, args)
    if (other && other !== ctx.personId) {
      await requireCapability(ctx.tenant, 'goal.manage')
      personIds = [other]
    }

    // Amount is derived from the goal's type (the "what counting" decision):
    //   habit                → one completion (forced to 1).
    //   total + a time unit  → hours + minutes folded to decimal hours.
    //   count                → a whole number (rounded).
    //   other total          → the raw numeric amount.
    let amount: number
    if (goal.goal_type === 'habit') {
      amount = 1
    } else if (goal.goal_type === 'total' && isTimeUnit(goal.unit)) {
      amount = numOr0(args.hours) + numOr0(args.minutes) / 60
      if (!(amount > 0)) throw httpError(400, 'log some time — hours and minutes cannot both be zero')
    } else if (goal.goal_type === 'count') {
      amount = args.amount == null ? 1 : Math.round(Number(args.amount))
      if (!Number.isFinite(amount) || amount === 0) throw httpError(400, 'a count goal is logged in whole numbers')
    } else {
      amount = Number(args.amount)
      if (!Number.isFinite(amount) || amount === 0) throw httpError(400, 'amount must be a non-zero number')
    }

    await logProgress(ctx.tenant, cmd.targetId, amount, personIds, null, { at: null })
    return { message: `Logged progress on "${goal.title}"` }
  },
}

// Wire the target into the capture registry. Called from registerGoalRoutes so it runs
// at the same startup seam every module's routes register at.
export function registerGoalCaptureTarget(): void {
  registerCaptureTarget('goal', goalTarget)
}
