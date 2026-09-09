// Weekly Planning · step 1 "Loose ends" — this step's API client and its types.
//
// STEP 1 IS INTAKE, NOT REPAIR. Its main verb is ROUTING, which changes nothing in your modules.
// Two answers are the exceptions and do write: "It's done already" and, on a parked note, "Drop it".
//
// "Not done" is COMPUTED by the server from the modules that own the work (never the grocery list,
// which rebuilds itself). "Parked" is what somebody wrote down and exists nowhere else yet.
//
// THE CROSS-STEP CONTRACT is `LooseEndRoute`, persisted on step 1's own
// `planning_session_steps.data` as `{ routes: [...] }` — so the destination steps need no new
// endpoint, they read it off the session view they already receive.
import { apiGet, apiSend } from '../client'
import { emit } from '../bus'

export type LooseEndKind = 'chore' | 'list' | 'rhythm' | 'goal' | 'parked'

// The two answers that WRITE. Routing is not one of them — see the header.
export type LooseEndAction = 'done' | 'drop'

/** Who a loose end belongs to. Colour and avatar travel WITH the name, so no second read. */
export interface LooseEndOwner {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

export interface LooseEnd {
  // Unique across kinds and stable across refetches — the list key, and what the deck remembers.
  key: string
  kind: LooseEndKind
  id: string
  title: string
  emoji: string | null
  // The one line under the title, server-composed so web and iOS say the same thing.
  detail: string | null
  // Which of done/drop THIS item can take, decided per item by the server (a chore wanting photo
  // proof can't be completed here). The client renders what it's given rather than reading `kind`.
  actions: LooseEndAction[]
  /**
   * Who already has it, or null for "nobody has this" — a real state, and the row worth routing.
   */
  owner: LooseEndOwner | null
}

// Where a card can send an item — filtered by the server to the steps this household runs.
export interface LooseEndDestination {
  to: string
  label: string
  hint: string
  primary?: boolean
}

// WHAT STEP 1 DECIDED, and the shape every later step reads.
export interface LooseEndRoute {
  kind: LooseEndKind
  id: string
  // The title as it read when routed, so a later step needn't re-read four modules. A label,
  // never a source of truth.
  title: string
  source: LooseEndGroup
  to: string
}

/** A list the step could ask about. Grocery (it rebuilds itself) and templates are never candidates. */
export interface PlanningListCandidate {
  id: string
  name: string
  emoji: string | null
  /** How it currently stands — false only when the household has ruled it out. */
  relevant: boolean
}

export interface LooseEndsView {
  weekStart: string
  notDone: LooseEnd[]
  parked: LooseEnd[]
  // The server's own tally. The card deck derives its badges from the lists themselves, because
  // "leave it open" writes nothing the server can see; this is for the recap and iOS.
  counts: { notDone: number; parked: number }
  destinations: { notDone: LooseEndDestination[]; parked: LooseEndDestination[] }
  routes: LooseEndRoute[]
  // Friendly names of the modules actually read, so the cleared state never claims a module off.
  sources: string[]
  /**
   * The lists this step COULD ask about (the `custom` allowlist, resolved server-side).
   * `sources` is derived from the same value, so the two cannot disagree.
   */
  lists?: PlanningListCandidate[]
}

// `note` is the full explanation and travels with the SWITCH, which in one-at-a-time mode IS the
// explanation of the two kinds. `caption` is the four-word version for the see-all screen.
export const LOOSE_END_GROUPS = [
  {
    key: 'notDone' as const,
    label: 'Not done',
    caption: 'already in the app',
    // Says what the step DOES read, and stops. The exclusions live in the server read, which owns them.
    note: 'Computed from your modules — overdue chores, unchecked items on your lists, rhythms past due, habit goals short for the week. Nobody typed these; they are simply still open.',
  },
  {
    key: 'parked' as const,
    label: 'Parked',
    caption: 'somebody wrote it down',
    note: 'What somebody wrote down during the week that exists nowhere else yet. Which is why one of the answers here is to drop it.',
  },
]
export type LooseEndGroup = (typeof LOOSE_END_GROUPS)[number]['key']

// Both answers read differently by group: the same word means a different thing to a note.
export function looseEndActionLabel(action: LooseEndAction, kind: LooseEndKind): string {
  if (action === 'done') return kind === 'parked' ? 'Talk about it now' : "It's done already"
  return 'Drop it'
}

export function looseEndActionHint(action: LooseEndAction, kind: LooseEndKind): string {
  if (action === 'done') return kind === 'parked' ? 'Two minutes, then decide' : 'Just tell its module'
  return 'It was never really a thing'
}

export const looseEndsApi = {
  get: (weekStart?: string, sessionId?: string) => {
    const q = new URLSearchParams()
    if (weekStart) q.set('weekStart', weekStart)
    if (sessionId) q.set('sessionId', sessionId)
    const qs = q.toString()
    return apiGet<LooseEndsView>(`/api/weekly-planning/loose-ends${qs ? `?${qs}` : ''}`)
  },

  // THE STEP'S MAIN VERB — it touches no module. `to: null` undoes the routing (the trail's Undo).
  route: (
    sessionId: string,
    item: { kind: LooseEndKind; id: string; title: string },
    source: LooseEndGroup,
    to: string | null
  ) =>
    apiSend<{ routes: LooseEndRoute[] }>('POST', '/api/weekly-planning/loose-ends/route', {
      sessionId,
      kind: item.kind,
      id: item.id,
      title: item.title,
      source,
      to,
    }).then((r) => {
      emit('weeklyPlanning')
      return r
    }),

  // The two answers that DO write, so every surface showing that module hears about it — hence the
  // extra topics. `sessionId` retires any route this item had.
  resolve: (kind: LooseEndKind, id: string, action: LooseEndAction, sessionId?: string) =>
    apiSend<{ ok: true }>('POST', '/api/weekly-planning/loose-ends/resolve', { kind, id, action, sessionId }).then((r) => {
      emit('weeklyPlanning')
      if (kind === 'chore') emit('chores')
      if (kind === 'list') emit('grocery')
      if (kind === 'rhythm') emit('rhythms')
      if (kind === 'goal') emit('goals')
      return r
    }),

  // FIX WHAT YOU JUST WROTE — the words, the tag, or both. BOTH FIELDS ARE READ FOR PRESENCE by
  // the server, hence `stepKey: string | null | undefined`: omitting it leaves the tag alone,
  // `null` means "No tag". Pass `sessionId` or a routed note's trail entry is left disagreeing.
  update: (id: string, patch: { note?: string; stepKey?: string | null; sessionId?: string }) =>
    apiSend<{ item: { id: string; note: string; stepKey: string | null }; routes?: LooseEndRoute[] }>(
      'PATCH',
      `/api/weekly-planning/loose-ends/parked/${encodeURIComponent(id)}`,
      {
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.stepKey !== undefined ? { stepKey: patch.stepKey } : {}),
        ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
      }
    ).then((r) => {
      emit('weeklyPlanning')
      return r
    }),

  // The capture bar under group B. Step 3 calls this too, passing `stepKey: 'horizon'`.
  park: (note: string, opts?: { stepKey?: string; sessionId?: string }) =>
    apiSend<{ item: { id: string; note: string } }>('POST', '/api/weekly-planning/loose-ends/parked', {
      note,
      ...(opts?.stepKey ? { stepKey: opts.stepKey } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    }).then((r) => {
      emit('weeklyPlanning')
      return r
    }),
}
