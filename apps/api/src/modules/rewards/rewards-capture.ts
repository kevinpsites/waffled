// Rewards' capture target resolves spoken reward names and redeems the chosen item.
// Commit shares requestRedemption with POST /api/rewards/:id/redeem, keeping the
// approval and balance guards consistent. The service also enforces reward.approve
// when spending another person's balance; catalog permission is not required.
import { rewardsEnabled } from '../../platform/modules'
import {
  registerCaptureTarget,
  httpError,
  findPersonByName,
  type CaptureTarget,
  type ResolveCtx,
  type ResolveRequest,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { rankCandidates, type Candidate, type RankRow } from '../capture/candidate-match'
import { listRewards, requestRedemption } from './rewards'

const rewardCaptureTarget: CaptureTarget = {
  isEnabled: (ctx: ResolveCtx) => rewardsEnabled(ctx.settings),
  disabledReason: 'Rewards is turned off.',
  supportedVerbs: ['redeem'],

  async resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]> {
    const rewards = await listRewards(ctx.householdId)
    const byId = new Map(rewards.map((r) => [r.id, r]))
    const rows: RankRow[] = rewards.map((r) => ({ id: r.id, title: r.title }))
    // subtitle = the price, so the pick-one confirm reads like the shop tile.
    return rankCandidates(req.target.description, rows).map((c) => {
      const r = byId.get(c.id)!
      return {
        ...c,
        subtitle: `${r.cost} ${r.currency}`,
        meta: { cost: r.cost, currency: r.currency, requiresApproval: r.requires_approval },
      }
    })
  },

  async applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }> {
    if (cmd.verb !== 'redeem') throw httpError(400, "Can't do that to a reward")

    // Who gets it: a spoken name ("Wally spent 50 points on …") or the speaker —
    // mirrors the route's `personId ?? tenant.personId` default.
    let personId = ctx.personId
    let forName: string | null = null
    const personName = typeof cmd.args.personName === 'string' ? cmd.args.personName.trim() : ''
    if (personName) {
      const person = await findPersonByName(ctx.householdId, personName)
      if (!person) throw httpError(400, "Couldn't find that person.")
      personId = person.id
      forName = person.name
    }

    const red = await requestRedemption(ctx.tenant, cmd.targetId, personId)
    if (red === null) throw httpError(404, 'That reward is gone.')
    // Same shape the route 409s (the auto path's balance guard).
    if ('error' in red) throw httpError(409, red.error)

    const who = forName ? ` for ${forName}` : ''
    if (red.status === 'pending') {
      return { message: `Requested "${red.title}"${who} — waiting for approval` }
    }
    return { message: `Redeemed "${red.title}"${who} (−${red.cost} ${red.currency})` }
  },
}

// Called from registerRewardRoutes(api) at startup wiring so the target is in the
// registry before any /api/capture/{resolve,commit} request arrives.
export function registerRewardCaptureTarget(): void {
  registerCaptureTarget('reward', rewardCaptureTarget)
}
