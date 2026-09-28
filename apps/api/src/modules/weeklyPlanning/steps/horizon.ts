// Weekly Planning · step 3 "Horizon scan" — the month you already have, plus one bar.
//
// The month is the plain calendar read and the app's own event modal, so there is
// deliberately NO month endpoint here: a mirror of the calendar would be a second door
// onto the same rows and the two would drift. Parking is likewise not re-implemented —
// `parkItem` in ./looseEnds.ts is the one writer.
//
// All this file is, then, is the read the bar cannot derive:
//
//   1. WHICH TAGS a note may carry, filtered to the steps this household runs;
//   2. WHAT THIS SESSION HAS PARKED — `setDecisionData` is not storage (it reaches the
//      server only when the step is answered), so anything that must still be true on a
//      second visit is read back from the table that owns it.
import { query } from '../../../platform/db'
import { resolveSteps, STEPS } from '../weeklyPlanning'

// THE TAG IS THE DESTINATION STEP, not 'horizon'.
//
// `planning_parked_items.step_key` answers "which step is going to look at this?", so a
// note tagged Tasks stores 'tasks' — the same value step 1 writes when somebody routes a
// note there. One meaning for the column, and a consumer cannot tell the two producers
// apart. (0101's own comment sketches 'horizon'; nothing reads that today.)
//
// ONLY THE STEPS STILL AHEAD, hence derived from `STEPS` order rather than a hand-kept
// list: a tag names the step that will LOOK at the note, so a step already walked past
// addresses the note to nobody until a later session. A step earns its place by having a
// HINT — the editorial opt-in that keeps `recap` out.
//
// "No tag" is the ABSENCE of a tag and so is never a row here.
const TAG_HINTS: Record<string, string> = {
  familyNight: 'It belongs to the gathering',
  connection: 'It’s time with someone',
  goals: 'Somebody’s working on it',
  meals: 'It changes what we eat',
  tasks: 'Someone owns it this week',
  kids: 'It’s about one of the kids',
}

// The tag the bar opens on: most of what a month provokes is something somebody has to DO
// before the date arrives.
const PRIMARY_TAG = 'tasks'

const BAR_STEP = 'horizon'

export interface HorizonTag {
  stepKey: string
  label: string
  hint: string
  primary?: boolean
}

export interface HorizonNote {
  id: string
  note: string
  stepKey: string | null
  stepLabel: string | null
  createdAt: string
}

export interface HorizonView {
  tags: HorizonTag[]
  parked: HorizonNote[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface NoteRow {
  id: string
  note: string
  step_key: string | null
  created_at: Date
}

/** The bar's tags and this session's board. `sessionId` is optional: without one the tags
 *  still come back, so the bar is renderable before a session exists. */
export async function getHorizon(householdId: string, sessionId: string | null): Promise<HorizonView> {
  const steps = await resolveSteps(householdId, null)
  const live = new Map(steps.filter((s) => s.available).map((s) => [s.key, s.title]))
  const after = STEPS.slice(STEPS.findIndex((s) => s.key === BAR_STEP) + 1)
  const tags: HorizonTag[] = after.flatMap((s) => {
    const hint = TAG_HINTS[s.key]
    const label = live.get(s.key)
    return hint && label ? [{ stepKey: s.key, label, hint, ...(s.key === PRIMARY_TAG ? { primary: true } : {}) }] : []
  })

  if (!sessionId || !UUID_RE.test(sessionId)) return { tags, parked: [] }

  // Every OPEN note parked during this session, whichever bar wrote it (resolved and
  // dropped ones have been answered). Household-scoped as well as session-scoped — the
  // session id alone is untrusted input. `title` is joined from the CATALOG rather than
  // stored, so retitling a step renames every tag at once.
  const { rows } = await query<NoteRow>(
    `select id, note, step_key, created_at
       from planning_parked_items
      where household_id = $1 and session_id = $2 and status = 'open'
      order by created_at, id
      limit 200`,
    [householdId, sessionId]
  )
  const titles = new Map(steps.map((s) => [s.key, s.title]))
  return {
    tags,
    parked: rows.map((r) => ({
      id: r.id,
      note: r.note,
      stepKey: r.step_key,
      stepLabel: r.step_key ? (titles.get(r.step_key) ?? null) : null,
      createdAt: r.created_at.toISOString(),
    })),
  }
}
