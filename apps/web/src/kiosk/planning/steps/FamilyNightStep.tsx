import { useEffect, useState, useSyncExternalStore } from 'react'
import { avTint } from '../../components/Avatar'
import { addDays, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import {
  planningFamilyNightApi,
  planningFamilyNightDecision,
  useEventsRange,
  weekdayName,
  type PlanningFamilyNightBoard,
  type PlanningFamilyNightPart,
} from '../../../lib/api'
import '../../../styles/planning-familyNight.css'

// Step 4 · Family night. The affirmative is an acknowledgement: it writes nothing.
//
// Every decision goes through the familyNight module's occurrence endpoint: a tapped face
// assigns on the OCCURRENCE (this week only; materializing it shifts next week's turn) and
// "Skip this week" is status 'skipped', calling off the GATHERING, not the recurring event.
// A SKIPPED WEEK STILL TAKES ITS TURN — the rotation COUNTS occurrences, so do NOT "fix"
// `rotationIndex()` to exclude them.

interface StepState {
  key: string
  board: PlanningFamilyNightBoard | null
  loading: boolean
  error: string | null
  busy: boolean
}

const EMPTY: StepState = { key: '', board: null, loading: true, error: null, busy: false }

// Body and FooterExtra are SIBLING trees under the shell, so the state must outlive both.
let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

async function load(key: string, weekStart: string) {
  set({ ...EMPTY, key })
  try {
    const board = await planningFamilyNightApi.board(weekStart)
    if (state.key !== key) return // a later week won the race
    set({ board, loading: false })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read this week's family night — reload and try again." })
  }
}

async function reread(weekStart: string) {
  // Never over a write in flight: that read left before the write landed, so applying it
  // would put the pre-write board back on screen. `write` re-reads anyway.
  if (state.busy) return
  const key = state.key
  const board = await planningFamilyNightApi.board(weekStart)
  if (state.key === key && !state.busy) set({ board })
}

// Every write is followed by a re-read, not a local patch: the server owns which parts are
// on rotation, and guessing is how this screen and the Today card disagree.
async function write(p: StepBodyProps, run: (date: string) => Promise<unknown>) {
  const board = state.board
  const key = state.key
  if (!board || state.busy) return
  set({ busy: true, error: null })
  try {
    await run(board.date)
    const fresh = await planningFamilyNightApi.board(p.weekStart)
    if (state.key !== key) return // the week moved on under us; that board isn't this one
    set({ board: fresh, busy: false })
  } catch {
    if (state.key === key) set({ busy: false, error: "That didn't take — try again." })
  }
  p.refresh()
}

// `primary` (only Body passes it) says which component owns the fetching, so a remount
// doesn't fire two reads.
function useFamilyNightStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  useEffect(() => {
    if (state.key !== key) void load(key, p.weekStart)
    else if (primary && !state.loading) void reread(p.weekStart).catch(() => { /* the card simply stays as it was */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const s = useSyncExternalStore(subscribe, snapshot)
  // The crumb, kept in step with every read and write so the affirmative writes back.
  useEffect(() => {
    if (primary && s.board) p.setDecisionData(planningFamilyNightDecision(s.board))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, s.board])
  return s
}

// ── Bits ─────────────────────────────────────────────────────────────────────────

// "Wednesday, Sep 9" — a fixed noon, so no timezone shifts the gathering onto the day before.
function longDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function clockTime(time: string): string {
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time
  const d = new Date(2000, 0, 1, h, m)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function PartRow({ part, board, p, disabled }: {
  part: PlanningFamilyNightPart
  board: PlanningFamilyNightBoard
  p: StepBodyProps
  disabled: boolean
}) {
  const sub = part.personName === null
    ? 'nobody yet'
    : part.pinned
      ? `pinned for this week · ${part.personName}`
      : `suggested · ${part.personName}, next in the rotation`

  return (
    <div className="wpfn-row" data-testid={`wpfn-row-${part.label}`}>
      <div className="wpfn-emoji" aria-hidden>{part.emoji}</div>
      <div className="wpfn-main">
        <div className="wpfn-label">{part.label}</div>
        <div className={`wpfn-sug${part.pinned ? ' pinned' : ''}`}>{sub}</div>
      </div>
      <div className="wpfn-faces">
        {board.members.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`wpfn-face${m.id === part.personId ? ' on' : ''}`}
            style={{ background: avTint(m.colorHex) }}
            // The label is always the ACTION: tapping the suggested person turns the guess
            // into a decision.
            aria-label={`Pin ${part.label} to ${m.name}`}
            // Only a PIN is a pressed state — the rotation's suggestion is merely current.
            aria-pressed={part.pinned && m.id === part.personId}
            title={`${m.name} takes ${part.label.toLowerCase()}`}
            disabled={disabled}
            onClick={() => void write(p, (date) => planningFamilyNightApi.pin(date, part.partId, m.id))}
          >
            {m.avatarEmoji ?? '🙂'}
          </button>
        ))}
      </div>

      {/* WHAT the part is, as opposed to whose turn it is. Sent without `personId`, so
          naming the treat leaves whoever has it alone and the rotation's suggestion
          stands (the server reads presence — see setDetail). */}
      <CommitLine
        className="wpfn-detail"
        label="What"
        srLabel={`What is the ${part.label.toLowerCase()}?`}
        value={part.detail ?? ''}
        placeholder={DETAIL_HINTS[part.partId] ?? `optional — what's the ${part.label.toLowerCase()}?`}
        maxLength={200}
        disabled={disabled}
        onCommit={(text) => void write(p, (date) => planningFamilyNightApi.setDetail(date, part.partId, text))}
      />
    </div>
  )
}

// Keyed by the DEFAULT slugs only: a renamed or added part falls through to the generic one.
const DETAIL_HINTS: Record<string, string> = {
  activity: 'optional — "charades, kids vs parents"',
  treat: 'optional — "the good ice cream"',
  checkin: 'optional — "how was school, actually"',
}

/**
 * A free-text line saved on blur (and on Enter), not per keystroke. Shared by the theme and
 * every part's detail: same clearing rule ('' clears, null means "leave it").
 */
function CommitLine({ label, srLabel, value, placeholder, maxLength, disabled, onCommit, className }: {
  label: string
  /**
   * The accessible name, when the visible label is too terse: three rows showing "What"
   * need distinct names, and the visible word cannot repeat the part's own label.
   */
  srLabel?: string
  value: string
  placeholder: string
  maxLength: number
  disabled: boolean
  onCommit: (text: string) => void
  className: string
}) {
  const [draft, setDraft] = useState(value)
  // Re-sync when the board comes back changed; a draft survives its own re-read.
  useEffect(() => { setDraft(value) }, [value])

  const commit = () => {
    if (draft === value || disabled) return
    onCommit(draft.trim())
  }

  // The app's own labelled-field shape, so it inherits the design system's input and the
  // label is the accessible name for free.
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      <input
        type="text"
        {...(srLabel ? { 'aria-label': srLabel } : {})}
        value={draft}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
      />
    </label>
  )
}

// A free-text line on the night, saved on blur (and on Enter) — see `DetailField`.
function ThemeLine({ board, p, disabled }: { board: PlanningFamilyNightBoard; p: StepBodyProps; disabled: boolean }) {
  return (
    <CommitLine
      className="wpfn-theme"
      label="Theme"
      value={board.theme ?? ''}
      placeholder='optional — "pizza and the new Lego set"'
      maxLength={120}
      disabled={disabled}
      // '' clears; null would mean "leave whatever is there" to the server's upsert.
      onCommit={(text) => void write(p, (date) => planningFamilyNightApi.setTheme(date, text))}
    />
  )
}

/**
 * The week's events, to point one at. Its own component so the FETCH only happens once
 * somebody opens the picker: a hook cannot be called conditionally.
 */
function EventPicker({ weekStart, disabled, onPick }: {
  weekStart: string
  disabled: boolean
  onPick: (eventId: string) => void
}) {
  // The last day of the week the SERVER handed us — never a week computed here.
  const { events } = useEventsRange(weekStart, ymd(addDays(new Date(`${weekStart}T00:00:00`), 6)))
  // A meal-plan mirror is not family night; offering one puts a dinner where an evening goes.
  const linkable = events.filter((e) => e.origin !== 'meal_plan' && e.origin !== 'meal_prep')

  return (
    <ul className="wpfn-cal-list" aria-label="Events on this week">
      {linkable.length === 0 && <li className="wpfn-cal-empty">Nothing on the week to point at yet.</li>}
      {linkable.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            className="wpfn-cal-pick"
            disabled={disabled}
            onClick={() => onPick(e.id)}
          >
            {e.title}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * This week's gathering on the calendar. TWO things live here: `onCalendar` is the STANDING
 * recurring series, set once in Settings, while `eventId` is the event THIS gathering points
 * at — the one a session can decide. "Add to calendar" is one server call that creates and
 * links atomically, because the web writes events LOCALLY first and a client id would not
 * exist server-side yet.
 */
function CalendarLine({ board, p, disabled }: {
  board: PlanningFamilyNightBoard
  p: StepBodyProps
  disabled: boolean
}) {
  const [picking, setPicking] = useState(false)

  if (board.eventId) {
    return (
      <div className="wpfn-cal" data-testid="wpfn-cal">
        <span className="wpfn-cal-emoji" aria-hidden>📅</span>
        <div className="wpfn-cal-main">
          <div className="wpfn-cal-t">{board.eventTitle}</div>
          <div className="wpfn-cal-s">{board.eventWhen} · on the calendar for this week</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost wpfn-cal-act"
          disabled={disabled}
           // Unlinks ONLY: "this isn't family night after all" must never delete Friday.
          onClick={() => void write(p, (date) => planningFamilyNightApi.linkEvent(date, null))}
        >
          Unlink
        </button>
      </div>
    )
  }

  return (
    <div className="wpfn-cal" data-testid="wpfn-cal">
      <span className="wpfn-cal-emoji" aria-hidden>📅</span>
      <div className="wpfn-cal-main">
        <div className="wpfn-cal-t">Not on the calendar this week</div>
        <div className="wpfn-cal-s">
          {board.onCalendar
            ? 'The standing weekly event still stands — this is for a one-off, or to point at something already on the week.'
            : 'Add it as an event, or point at something already on the week.'}
        </div>
        <div className="wpfn-cal-acts">
          <button
            type="button"
            className="btn btn-ghost wpfn-cal-act"
            disabled={disabled}
            onClick={() => { setPicking(false); void write(p, (date) => planningFamilyNightApi.addEvent(date)) }}
          >
            Add to calendar
          </button>
          <button
            type="button"
            className="btn btn-ghost wpfn-cal-act"
            disabled={disabled}
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          >
            {picking ? 'Never mind' : 'Link an event'}
          </button>
        </div>

        {picking && (
          <EventPicker
            weekStart={board.weekStart}
            disabled={disabled}
            onPick={(eventId) => { setPicking(false); void write(p, (date) => planningFamilyNightApi.linkEvent(date, eventId)) }}
          />
        )}
      </div>
    </div>
  )
}

// ── Body ─────────────────────────────────────────────────────────────────────────

function Body(p: StepBodyProps) {
  const s = useFamilyNightStep(p, true)
  const disabled = p.busy || s.busy

  if (s.loading) return <div className="wp-empty">Reading this week's family night…</div>
  if (!s.board) return <div className="wp-empty">{s.error ?? "Couldn't read this week's family night."}</div>

  const b = s.board
  const skipped = b.status === 'skipped'

  return (
    <div className="wpfn">
      <div className={`wpfn-card${skipped ? ' skipped' : ''}`}>
        <div className="wpfn-h">
          <div className="wpfn-t">🏡 Family Night</div>
          <div className="wpfn-rec">every {weekdayName(b.dayOfWeek)}</div>
          <div className="wpfn-when">{longDate(b.date)} · {clockTime(b.time)}</div>
        </div>

        <ThemeLine board={b} p={p} disabled={disabled || skipped} />

        {b.parts.map((part) => (
          <PartRow key={part.partId} part={part} board={b} p={p} disabled={disabled || skipped} />
        ))}

        {b.members.length === 0 && (
          <div className="wpfn-note">Add family members and the rotation has somebody to offer.</div>
        )}

        <CalendarLine board={b} p={p} disabled={disabled || skipped} />
      </div>

      {skipped ? (
        <div className="wpfn-skipbar">
          <span className="wpfn-skip-emoji" aria-hidden>⏭</span>
          <div className="wpfn-skip-main">
            <div className="wpfn-skip-t">Skipped this week</div>
            <div className="wpfn-skip-s">
              The gathering is marked skipped{b.onCalendar && ', and the recurring calendar event is left alone'}.
              Everyone&rsquo;s turn still moves on, so next week is the next person up.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost wpfn-undo"
            disabled={disabled}
            onClick={() => void write(p, (date) => planningFamilyNightApi.setStatus(date, 'planned'))}
          >
            Undo
          </button>
        </div>
      ) : (
        // NOT "who did what last time": the rotation COUNTS gatherings against the family's
        // order and never reads who was assigned.
        <div className="wpfn-note">
          These are <b>rotation suggestions</b> — each part taken in turn, in your family's order.
          Leave them and they stand; tap a face and it's pinned for this week only, which is what
          shifts next week's turn.
        </div>
      )}

      {s.error && <div className="wpfn-err">{s.error}</div>}
    </div>
  )
}

// ── FooterExtra ──────────────────────────────────────────────────────────────────
// "Skip this week" — not the shell's "Skip this step", which decides nothing. Once the week
// is off this slot empties: the way back is Undo on the skip bar.

function FooterExtra(p: StepBodyProps) {
  const s = useFamilyNightStep(p)
  if (!s.board || s.board.status === 'skipped') return null
  return (
    <button
      type="button"
      className="btn btn-ghost wpfn-skip"
      disabled={p.busy || s.busy}
      onClick={() => void write(p, (date) => planningFamilyNightApi.setStatus(date, 'skipped'))}
    >
      Skip this week
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
