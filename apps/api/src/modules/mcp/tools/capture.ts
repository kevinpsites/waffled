// The capture verbs as MCP tools: a find_* tool per target kind returns candidates (so the
// agent can ask the user when it's ambiguous) and one tool per verb applies the chosen id.
// Both go through the capture registry, so each module's own resolver, capability checks
// and occurrence-vs-series rules apply unchanged. One scope per tool forces per-kind tools.
import {
  buildResolveCtx,
  getCaptureTarget,
  unsupportedVerbReason,
  type MutateVerb,
  type TargetKind,
} from '../../capture/capture-resolvers'
import type { Tenant } from '../../households/households'
import type { ModuleKey } from '../../../platform/modules'
import { defineTool, ToolInputError, type ToolAnnotations } from '../registry'
import { DATE_SCHEMA, ID_SCHEMA, optEnum, reqString, reqUuid } from '../args'
import { DATA_NOTE, DESTRUCTIVE, READ, WRITE } from './shared'

const MAX_CANDIDATES = 20

async function readyTarget(tenant: Tenant, kind: TargetKind, verb: MutateVerb) {
  const target = getCaptureTarget(kind)
  if (!target) throw new ToolInputError(`${kind} actions are not available`)
  if (!target.supportedVerbs.includes(verb)) throw new ToolInputError(unsupportedVerbReason(kind, verb))
  const ctx = await buildResolveCtx(tenant)
  if (!target.isEnabled(ctx)) throw new ToolInputError(target.disabledReason)
  return { target, ctx }
}

interface FindSpec {
  name: string
  kind: TargetKind
  scope: string
  module?: ModuleKey | 'rewards'
  verbs: MutateVerb[]
  noun: string
  next: string
}

function defineFind(spec: FindSpec): void {
  defineTool({
    name: spec.name,
    description:
      `Find ${spec.noun} matching what the user called it, best match first, each with a confidence 0–1. ` +
      `Pick the id to pass to ${spec.next}; when several match closely, ask the user which one.` +
      (spec.verbs.length > 1 ? ` verb (${spec.verbs.join(' or ')}) narrows to rows that action applies to.` : '') +
      DATA_NOTE,
    scope: spec.scope,
    module: spec.module,
    annotations: { title: `Find ${spec.noun}`, ...READ },
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the user called it' },
        ...(spec.verbs.length > 1 ? { verb: { type: 'string', enum: spec.verbs } } : {}),
      },
      required: ['description'],
      additionalProperties: false,
    },
    run: async (tenant, args) => {
      const description = reqString(args, 'description', 200)
      const verb = optEnum(args, 'verb', spec.verbs) ?? spec.verbs[0]
      const { target, ctx } = await readyTarget(tenant, spec.kind, verb)
      const all = await target.resolveCandidates(ctx, { verb, target: { description }, args: {} })
      const candidates = all.slice(0, MAX_CANDIDATES)
      return {
        data: { candidates, truncated: all.length > candidates.length },
        summary: candidates.length
          ? `${candidates.length} match(es); best: ${candidates[0].title}${candidates[0].subtitle ? ` (${candidates[0].subtitle})` : ''}.`
          : `No ${spec.noun} match "${description}".`,
      }
    },
  })
}

interface ActionSpec {
  name: string
  kind: TargetKind
  verb: MutateVerb
  scope: string
  module?: ModuleKey | 'rewards'
  title: string
  description: string
  annotations: ToolAnnotations
  // Extra verb arguments: JSON Schema properties, and a reader that validates them.
  properties?: Record<string, unknown>
  readArgs?: (args: Record<string, unknown>) => Record<string, unknown>
}

function defineAction(spec: ActionSpec): void {
  defineTool({
    name: spec.name,
    description: spec.description + DATA_NOTE,
    scope: spec.scope,
    module: spec.module,
    annotations: { title: spec.title, ...spec.annotations },
    inputSchema: {
      type: 'object',
      properties: { id: { ...ID_SCHEMA, description: 'The id from a find_* or list tool' }, ...spec.properties },
      required: ['id'],
      additionalProperties: false,
    },
    run: async (tenant, args) => {
      const id = reqUuid(args, 'id')
      const verbArgs = spec.readArgs ? spec.readArgs(args) : {}
      const { target, ctx } = await readyTarget(tenant, spec.kind, spec.verb)
      const result = await target.applyMutation(ctx, { verb: spec.verb, targetId: id, args: verbArgs })
      const note = result.scope === 'occurrence' ? ' Only this occurrence was canceled; the rest of the series is unchanged.' : ''
      return { data: { ok: true, id, message: result.message, ...(result.scope ? { scope: result.scope } : {}) }, summary: `${result.message}.${note}` }
    },
  })
}

const personArg = {
  personId: { ...ID_SCHEMA, description: 'A member id from list_family' },
}
const readPerson = (args: Record<string, unknown>) => (args.personId != null ? { personId: reqUuid(args, 'personId') } : {})

defineFind({ name: 'find_chores', kind: 'chore', scope: 'chores:read', module: 'chores', verbs: ['complete', 'reassign'], noun: "today's chores", next: 'complete_chore or reassign_chore' })
defineFind({ name: 'find_list_items', kind: 'listItem', scope: 'lists:read', module: 'lists', verbs: ['complete', 'delete'], noun: 'list items', next: 'complete_list_item or delete_list_item' })
defineFind({ name: 'find_events', kind: 'event', scope: 'calendar:read', verbs: ['reschedule', 'delete'], noun: 'calendar events', next: 'reschedule_event or delete_event' })
defineFind({ name: 'find_goals', kind: 'goal', scope: 'goals:read', module: 'goals', verbs: ['log'], noun: 'goals', next: 'log_goal' })
defineFind({ name: 'find_rewards', kind: 'reward', scope: 'rewards:read', module: 'rewards', verbs: ['redeem'], noun: 'rewards', next: 'redeem_reward' })

defineAction({
  name: 'complete_chore',
  kind: 'chore',
  verb: 'complete',
  scope: 'chores:write',
  module: 'chores',
  title: 'Complete a chore',
  description: "Mark one of today's chores done. A chore that needs a parent's approval becomes 'awaiting'; one that needs a photo can't be completed here.",
  annotations: WRITE,
})

defineAction({
  name: 'reassign_chore',
  kind: 'chore',
  verb: 'reassign',
  scope: 'chores:write',
  module: 'chores',
  title: 'Reassign a chore',
  description: "Give one of today's chores to a family member. Anyone may take a chore themselves; giving it to someone else needs a parent's permission.",
  annotations: WRITE,
  properties: personArg,
  readArgs: (args) => ({ personId: reqUuid(args, 'personId') }),
})

defineAction({
  name: 'complete_list_item',
  kind: 'listItem',
  verb: 'complete',
  scope: 'lists:write',
  module: 'lists',
  title: 'Check off a list item',
  description: 'Check off an item on any list (e.g. bought it).',
  annotations: WRITE,
})

defineAction({
  name: 'delete_list_item',
  kind: 'listItem',
  verb: 'delete',
  scope: 'lists:write',
  module: 'lists',
  title: 'Remove a list item',
  description: 'Remove an item from its list.',
  annotations: DESTRUCTIVE,
})

defineAction({
  name: 'reschedule_event',
  kind: 'event',
  verb: 'reschedule',
  scope: 'calendar:write',
  title: 'Reschedule an event',
  description:
    'Move an upcoming event to a new day and/or time, in the household timezone; whichever half you leave out is kept, and so is the duration. For a recurring event only the given occurrence moves.',
  annotations: WRITE,
  properties: {
    date: { ...DATE_SCHEMA, description: 'New day, YYYY-MM-DD' },
    time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$', description: 'New start time, 24-hour HH:MM' },
  },
  readArgs: (args) => {
    const out: Record<string, unknown> = {}
    if (args.date != null) out.date = args.date
    if (args.time != null) out.time = args.time
    return out
  },
})

defineAction({
  name: 'delete_event',
  kind: 'event',
  verb: 'delete',
  scope: 'calendar:write',
  title: 'Cancel an event',
  description:
    "Cancel an upcoming event. For a recurring event this cancels ONLY the given occurrence (the result's scope says 'occurrence'); the series itself is never deleted here.",
  annotations: DESTRUCTIVE,
})

defineAction({
  name: 'log_goal',
  kind: 'goal',
  verb: 'log',
  scope: 'goals:write',
  module: 'goals',
  title: 'Log goal progress',
  description:
    "Log progress on a goal for the signed-in member (or personId, which needs permission when it's someone else). A habit always logs one completion; otherwise pass amount in the goal's unit, or hours/minutes for a time goal.",
  annotations: WRITE,
  properties: {
    amount: { type: 'number' },
    hours: { type: 'number' },
    minutes: { type: 'number' },
    ...personArg,
  },
  readArgs: (args) => {
    const out: Record<string, unknown> = { ...readPerson(args) }
    for (const k of ['amount', 'hours', 'minutes']) {
      if (args[k] == null) continue
      if (typeof args[k] !== 'number' || !Number.isFinite(args[k])) throw new ToolInputError(`${k} must be a number`)
      out[k] = args[k]
    }
    return out
  },
})

defineAction({
  name: 'redeem_reward',
  kind: 'reward',
  verb: 'redeem',
  scope: 'rewards:write',
  module: 'rewards',
  title: 'Redeem a reward',
  description:
    "Spend stars on a reward for the signed-in member, or for personId (spending someone else's balance needs a parent's permission). A reward that needs approval becomes a request a parent must OK.",
  annotations: DESTRUCTIVE,
  properties: personArg,
  readArgs: readPerson,
})
