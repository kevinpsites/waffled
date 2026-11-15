// Capture Tier 2 — the target registry (dependency inversion). Capture must never
// query or mutate another module's tables; instead each feature module registers its
// own resolver + applier here from inside its registerXxxRoutes(api). The two capture
// dispatcher routes (/api/capture/resolve, /api/capture/commit) are thin: look up the
// target by kind, then call it. This file imports NOTHING from sibling feature modules
// (so there is no cycle) — the feature modules import IT.
import { query } from '../../platform/db'
import type { Tenant } from '../households/households'
import type { Candidate } from './candidate-match'

export type TargetKind = 'chore' | 'goal' | 'listItem' | 'event' | 'reward'
export type MutateVerb = 'complete' | 'log' | 'reschedule' | 'reassign' | 'redeem' | 'delete'

// The resolved request context a dispatcher hands a target. Built from the Tenant +
// the household's settings/timezone — NOT from CaptureContext (which is names-only,
// for the stateless parse). `settings` is the raw households.settings JSON so a target
// can run moduleEnabled/rewardsEnabled against it.
export interface ResolveCtx {
  tenant: Tenant
  householdId: string
  personId: string
  now: Date
  timezone: string
  settings: unknown
}

// The echoed (unresolved) mutate intent a resolver searches against — verb + the
// spoken noun phrase + loose verb args. Never carries an id.
export interface ResolveRequest {
  verb: MutateVerb
  target: { description: string }
  args: Record<string, unknown>
}

// The chosen mutation to apply — targetId is a resolved Candidate.id; meta is echoed
// from that candidate (e.g. { occurrenceStart } for a recurring event).
export interface MutateCommand {
  verb: MutateVerb
  targetId: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface CaptureTarget {
  // Is the owning module enabled for this household? (moduleEnabled/rewardsEnabled
  // against ctx.settings.) A disabled target yields candidates:[] + disabledReason.
  isEnabled(ctx: ResolveCtx): boolean
  // Shown when isEnabled is false, e.g. "Chores is turned off."
  disabledReason: string
  // The verbs this target can actually apply. The dispatcher rejects any other verb
  // up front (resolve → unsupported, commit → 400) so the client never offers a
  // confirm button that would always fail.
  supportedVerbs: MutateVerb[]
  resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]>
  applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<MutationResult>
}

// `scope` says how much a delete touched, for callers that must report it (an event
// target cancels one occurrence of a recurring series, never the series).
export interface MutationResult {
  message: string
  scope?: 'occurrence' | 'event'
}

const REGISTRY = new Map<TargetKind, CaptureTarget>()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Register (or overwrite) the resolver/applier for a target kind. Idempotent — a
// re-register (e.g. re-imported routes in tests) simply replaces the entry.
export function registerCaptureTarget(kind: TargetKind, target: CaptureTarget): void {
  REGISTRY.set(kind, target)
}

export function getCaptureTarget(kind: TargetKind): CaptureTarget | undefined {
  return REGISTRY.get(kind)
}

// ── Shared helpers for target implementations + the dispatcher ────────────────

// The resolve/commit context for a resolved Tenant: the household's settings + timezone
// plus a fresh `now`. Shared by the capture routes and the MCP action tools.
export async function buildResolveCtx(tenant: Tenant): Promise<ResolveCtx> {
  const { rows } = await query<{ timezone: string; settings: unknown }>(
    `select timezone, settings from households where id = $1`,
    [tenant.householdId]
  )
  return {
    tenant,
    householdId: tenant.householdId,
    personId: tenant.personId,
    now: new Date(),
    timezone: rows[0]?.timezone ?? 'UTC',
    settings: rows[0]?.settings ?? null,
  }
}

// A thrown domain error the /api/capture/commit dispatcher shapes into a 4xx
// { error, message }. Lives in platform so route services can throw it too.
export { httpError } from '../../platform/http-error'

// Resolve a spoken person name → a live household member (case-insensitive exact match).
export async function findPersonByName(householdId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query<{ id: string; name: string }>(
    `select id, name from persons
      where household_id = $1 and lower(name) = lower($2) and deleted_at is null
      order by created_at limit 1`,
    [householdId, name.trim()]
  )
  return rows[0] ?? null
}

// The person a verb names: `personId` (an MCP agent passes ids) or a spoken `personName`.
export async function personFromArgs(householdId: string, args: Record<string, unknown>): Promise<{ id: string; name: string } | null> {
  if (args.personId != null) {
    if (typeof args.personId !== 'string' || !UUID_RE.test(args.personId)) return null
    const { rows } = await query<{ id: string; name: string }>(
      `select id, name from persons where household_id = $1 and id = $2 and deleted_at is null`,
      [householdId, args.personId]
    )
    return rows[0] ?? null
  }
  const name = typeof args.personName === 'string' ? args.personName.trim() : ''
  return name ? findPersonByName(householdId, name) : null
}

// Does the spoken phrase say "my"/"mine"/"our"? Then a resolver should prefer/scope to
// the speaker's own rows. The ranker strips these as stopwords, so targets sniff the
// raw description before ranking. One shared regex so chores/goals can't drift.
export function impliesMine(description: string): boolean {
  return /\b(my|mine|our)\b/i.test(description)
}

// Friendly copy for the two "quick-add can't do that" cases the dispatcher surfaces:
// a target kind nothing has registered (yet), and a verb the target doesn't apply.
const KIND_LABELS: Record<TargetKind, { noun: string; plural: string; page: string }> = {
  chore: { noun: 'chore', plural: 'chores', page: 'Chores' },
  goal: { noun: 'goal', plural: 'goals', page: 'Goals' },
  listItem: { noun: 'list item', plural: 'list items', page: 'Lists' },
  event: { noun: 'calendar event', plural: 'calendar events', page: 'Calendar' },
  reward: { noun: 'reward', plural: 'rewards', page: 'Rewards' },
}

// e.g. "Quick-add can't change calendar events yet — edit them on the Calendar page."
export function unsupportedKindReason(kind: string): string {
  const k = KIND_LABELS[kind as TargetKind]
  if (!k) return "Quick-add can't change that yet."
  return `Quick-add can't change ${k.plural} yet — edit them on the ${k.page} page.`
}

const VERB_LABELS: Record<MutateVerb, string> = {
  complete: 'complete',
  log: 'log progress on',
  reschedule: 'reschedule',
  reassign: 'reassign',
  redeem: 'redeem',
  delete: 'delete',
}

// e.g. "Quick-add can't delete a goal — you can do that from the Goals page."
export function unsupportedVerbReason(kind: TargetKind, verb: MutateVerb): string {
  const k = KIND_LABELS[kind]
  const v = VERB_LABELS[verb] ?? String(verb || 'do that to')
  if (!k) return "Quick-add can't do that yet."
  return `Quick-add can't ${v} a ${k.noun} — you can do that from the ${k.page} page.`
}
