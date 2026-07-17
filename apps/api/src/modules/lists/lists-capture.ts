// Lists' capture target — the Tier 2 "mutate verb" resolver/applier for list items.
// Registered into the capture registry from registerListRoutes so /api/capture/
// resolve + /api/capture/commit can turn a spoken noun phrase ("milk", "the bread on
// the Costco list") into one list_items row and apply complete/delete to it. Kept out
// of lists.routes.ts / lists.service.ts so those stay focused; imports the module's
// own service fns + the shared candidate ranker.
import { query } from '../../platform/db'
import { moduleEnabled } from '../../platform/modules'
import {
  registerCaptureTarget,
  httpError,
  type CaptureTarget,
  type ResolveCtx,
  type ResolveRequest,
  type MutateCommand,
} from '../capture/capture-resolvers'
import { rankCandidates, type Candidate, type RankRow } from '../capture/candidate-match'
import { setItemChecked, softDeleteItem } from './lists.service'

interface LiveItem {
  id: string
  name: string
  checked: boolean
  list_name: string
}

// The household's live items across every active list (templates' items are hidden
// from the rail, so they're not actionable here either). The list name rides along
// for the picker subtitle and the commit message.
async function liveItems(householdId: string): Promise<LiveItem[]> {
  const { rows } = await query<LiveItem>(
    `select i.id, i.name, i.checked, l.name as list_name
       from list_items i
       join lists l on l.id = i.list_id and l.deleted_at is null and l.list_type <> 'template'
      where i.household_id = $1 and i.deleted_at is null
      order by i.created_at`,
    [householdId]
  )
  return rows
}

// One item by id (for the commit path) — household-scoped, live lists only.
async function liveItem(householdId: string, id: string): Promise<LiveItem | null> {
  const { rows } = await query<LiveItem>(
    `select i.id, i.name, i.checked, l.name as list_name
       from list_items i
       join lists l on l.id = i.list_id and l.deleted_at is null and l.list_type <> 'template'
      where i.household_id = $1 and i.id = $2 and i.deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

const listItemCaptureTarget: CaptureTarget = {
  isEnabled: (ctx: ResolveCtx) => moduleEnabled(ctx.settings, 'lists'),
  disabledReason: 'Lists is turned off.',
  supportedVerbs: ['complete', 'delete'],

  async resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]> {
    const items = await liveItems(ctx.householdId)
    // For 'complete' an already-checked item is nothing to act on — drop it.
    const usable = req.verb === 'complete' ? items.filter((i) => !i.checked) : items
    const byId = new Map(usable.map((i) => [i.id, i]))
    const rows: RankRow[] = usable.map((i) => ({ id: i.id, title: i.name }))
    // subtitle = the list's name, so two same-named items ("Milk" on Groceries AND
    // Costco) read apart in the pick-one confirm.
    return rankCandidates(req.target.description, rows).map((c) => ({
      ...c,
      subtitle: byId.get(c.id)!.list_name,
    }))
  },

  async applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }> {
    const item = await liveItem(ctx.householdId, cmd.targetId)
    if (!item) throw httpError(404, 'That item is gone.')

    if (cmd.verb === 'complete') {
      // Same write PATCH /list-items/:id does (records who/when checked).
      const updated = await setItemChecked(ctx.tenant, cmd.targetId, true)
      if (!updated) throw httpError(404, 'That item is gone.')
      return { message: `Checked off "${item.name}"` }
    }

    if (cmd.verb === 'delete') {
      const ok = await softDeleteItem(ctx.householdId, cmd.targetId)
      if (!ok) throw httpError(404, 'That item is gone.')
      return { message: `Removed "${item.name}" from ${item.list_name}` }
    }

    // supportedVerbs gates this at the dispatcher; belt-and-suspenders.
    throw httpError(400, "Can't do that to a list item")
  },
}

// Called from registerListRoutes(api) at startup wiring so the target is in the
// registry before any /api/capture/{resolve,commit} request arrives.
export function registerListItemCaptureTarget(): void {
  registerCaptureTarget('listItem', listItemCaptureTarget)
}
