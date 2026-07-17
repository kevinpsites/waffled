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
  httpError,
  findPersonByName,
  impliesMine,
  type CaptureTarget,
  type ResolveCtx,
  type ResolveRequest,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { conceptKeywords } from './goal-match'
import { listGoals, logProgress, goalLogAmount, personsInHousehold } from './goals.service'

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
    const person = await findPersonByName(ctx.householdId, name)
    if (!person) throw httpError(400, 'unknown person')
    return person.id
  }
  return null
}

const goalTarget: CaptureTarget = {
  isEnabled: (ctx: ResolveCtx) => moduleEnabled(ctx.settings, 'goals'),
  disabledReason: 'Goals is turned off.',
  supportedVerbs: ['log'],

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
    const args = cmd.args ?? {}

    // Self-log is open; attributing to another person takes goal.manage (mirrors
    // the /api/goals/:id/log route). Default the credit to the speaker.
    let personIds = [ctx.personId]
    const other = await resolveOtherPerson(ctx, args)
    if (other && other !== ctx.personId) {
      await requireCapability(ctx.tenant, 'goal.manage')
      personIds = [other]
    }

    // Spoken-note defaults only — a habit log is always one completion, and a count
    // goal with no number means "one" ("log my reading goal" → 1 book). Everything
    // else passes through goalLogAmount, the SAME mapping/validation POST
    // /api/goals/:id/log uses, so the two entry points can never diverge.
    const hasNumbers = args.amount != null || args.hours != null || args.minutes != null
    const logBody: { amount?: unknown; hours?: unknown; minutes?: unknown } =
      goal.goal_type === 'habit' || (goal.goal_type === 'count' && !hasNumbers)
        ? { amount: 1 }
        : { amount: args.amount, hours: args.hours, minutes: args.minutes }
    const mapped = goalLogAmount({ goalType: goal.goal_type, unit: goal.unit }, logBody)
    if ('error' in mapped) throw httpError(400, mapped.error)

    await logProgress(ctx.tenant, cmd.targetId, mapped.amount, personIds, null, { at: null })
    return { message: `Logged progress on "${goal.title}"` }
  },
}

// Wire the target into the capture registry. Called from registerGoalRoutes so it runs
// at the same startup seam every module's routes register at.
export function registerGoalCaptureTarget(): void {
  registerCaptureTarget('goal', goalTarget)
}
