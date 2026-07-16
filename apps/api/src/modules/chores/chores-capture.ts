// Chores' capture target — the Tier 2 "mutate verb" resolver/applier for chores.
// Registered into the capture registry from registerChoreRoutes so /api/capture/
// resolve + /api/capture/commit can turn a spoken noun phrase ("the trash chore")
// into one chore_instances row and apply complete/reassign to it. Kept out of
// chores.routes.ts / chores.service.ts so those stay focused; imports the module's
// own service fns + the shared candidate ranker.
import { query } from '../../platform/db'
import { can } from '../../platform/permissions'
import { moduleEnabled } from '../../platform/modules'
import {
  registerCaptureTarget,
  type CaptureTarget,
  type ResolveCtx,
  type ResolveRequest,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { rankCandidates, type Candidate, type RankRow } from '../capture/candidate-match'
import {
  ensureTodayInstances,
  listTodayInstances,
  completeInstance,
  setInstanceAssignee,
  todayDate,
  ProofRequiredError,
} from './chores.service'

// A thrown domain error the /api/capture/commit dispatcher shapes into a 4xx
// { error, message } (it reads .statusCode + .message). Using a real Error keeps
// .name sensible and lint happy.
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = statusCode
  return err
}

// The chore title behind an instance id (for the commit confirmation message).
async function instanceTitle(householdId: string, instanceId: string): Promise<string | null> {
  const { rows } = await query<{ title: string }>(
    `select c.title from chore_instances ci
       join chores c on c.id = ci.chore_id
      where ci.household_id = $1 and ci.id = $2 and ci.deleted_at is null`,
    [householdId, instanceId]
  )
  return rows[0]?.title ?? null
}

// Resolve a spoken person name → a household member (case-insensitive exact match).
async function findPersonByName(householdId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query<{ id: string; name: string }>(
    `select id, name from persons
      where household_id = $1 and lower(name) = lower($2) and deleted_at is null
      order by created_at limit 1`,
    [householdId, name.trim()]
  )
  return rows[0] ?? null
}

const choreCaptureTarget: CaptureTarget = {
  isEnabled: (ctx: ResolveCtx) => moduleEnabled(ctx.settings, 'chores'),
  disabledReason: 'Chores is turned off.',

  async resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]> {
    // Recurring chores have no chore_instances row until they're materialized, so
    // materialize today's first, then list — candidate ids are those instance ids.
    const today = todayDate(ctx.timezone)
    await ensureTodayInstances(ctx.householdId, today)
    const instances = await listTodayInstances(ctx.householdId, today, ctx.timezone)
    const byId = new Map(instances.map((i) => [i.id, i]))

    // For 'complete' an already-done instance is nothing to act on — drop it.
    const usable = req.verb === 'complete' ? instances.filter((i) => i.status !== 'done') : instances
    const rows: RankRow[] = usable.map((i) => ({ id: i.id, title: i.choreTitle }))

    const ranked = rankCandidates(req.target.description, rows)
    const enriched: Candidate[] = ranked.map((c) => {
      const inst = byId.get(c.id)!
      return {
        id: c.id,
        title: c.title,
        subtitle: `${inst.personName ?? 'Up for grabs'} · ${inst.status}`,
        confidence: c.confidence,
        meta: { choreId: inst.choreId, assigneePersonId: inst.personId },
      }
    })

    // "my/mine …" → prefer the speaker's own instances, keeping confidence order within.
    if (/\b(my|mine)\b/i.test(req.target.description)) {
      enriched.sort((a, b) => {
        const am = a.meta?.assigneePersonId === ctx.personId ? 1 : 0
        const bm = b.meta?.assigneePersonId === ctx.personId ? 1 : 0
        if (am !== bm) return bm - am
        return b.confidence - a.confidence
      })
    }
    return enriched
  },

  async applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }> {
    if (cmd.verb === 'complete') {
      const title = await instanceTitle(ctx.householdId, cmd.targetId)
      if (!title) throw httpError(404, 'That chore is gone.')
      // Proof is optional; forward one only if the caller supplied a storage key.
      const proof =
        typeof cmd.args.storageKey === 'string'
          ? {
              storageKey: cmd.args.storageKey,
              contentType: typeof cmd.args.contentType === 'string' ? cmd.args.contentType : null,
            }
          : undefined
      try {
        const inst = await completeInstance(ctx.tenant, cmd.targetId, proof)
        if (!inst) throw httpError(404, 'That chore is gone.')
      } catch (err) {
        if (err instanceof ProofRequiredError) {
          throw httpError(422, 'That chore needs a photo — finish it in Chores.')
        }
        throw err
      }
      return { message: `Marked "${title}" done` }
    }

    if (cmd.verb === 'reassign') {
      const personName = typeof cmd.args.personName === 'string' ? cmd.args.personName.trim() : ''
      if (!personName) throw httpError(400, "Couldn't find that person.")
      const person = await findPersonByName(ctx.householdId, personName)
      if (!person) throw httpError(400, "Couldn't find that person.")
      // Same cap the /assign route enforces: assigning to ANOTHER person needs
      // chore.manage; taking it yourself stays open.
      if (person.id !== ctx.personId && !can(ctx.tenant.memberType, ctx.tenant.isAdmin, 'chore.manage', ctx.settings)) {
        throw httpError(403, 'Ask a parent to reassign a chore.')
      }
      const inst = await setInstanceAssignee(ctx.tenant, cmd.targetId, person.id)
      if (!inst) throw httpError(404, 'That chore is gone.')
      const title = (await instanceTitle(ctx.householdId, cmd.targetId)) ?? 'chore'
      return { message: `Reassigned "${title}" to ${person.name}` }
    }

    // complete + reassign only in this PR (delete-template deferred, see notes).
    throw httpError(400, "Can't do that to a chore")
  },
}

// Called from registerChoreRoutes(api) at startup wiring so the target is in the
// registry before any /api/capture/{resolve,commit} request arrives.
export function registerChoreCaptureTarget(): void {
  registerCaptureTarget('chore', choreCaptureTarget)
}
