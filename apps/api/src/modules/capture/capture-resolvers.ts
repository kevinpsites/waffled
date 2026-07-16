// Capture Tier 2 — the target registry (dependency inversion). Capture must never
// query or mutate another module's tables; instead each feature module registers its
// own resolver + applier here from inside its registerXxxRoutes(api). The two capture
// dispatcher routes (/api/capture/resolve, /api/capture/commit) are thin: look up the
// target by kind, then call it. This file imports NOTHING from sibling feature modules
// (so there is no cycle) — the feature modules import IT.
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
  resolveCandidates(ctx: ResolveCtx, req: ResolveRequest): Promise<Candidate[]>
  applyMutation(ctx: ResolveCtx, cmd: MutateCommand): Promise<{ message: string }>
}

const REGISTRY = new Map<TargetKind, CaptureTarget>()

// Register (or overwrite) the resolver/applier for a target kind. Idempotent — a
// re-register (e.g. re-imported routes in tests) simply replaces the entry.
export function registerCaptureTarget(kind: TargetKind, target: CaptureTarget): void {
  REGISTRY.set(kind, target)
}

export function getCaptureTarget(kind: TargetKind): CaptureTarget | undefined {
  return REGISTRY.get(kind)
}
