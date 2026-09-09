import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import {
  useWeeklyPlanning,
  weeklyPlanningApi,
  looseEndsApi,
  availableSteps,
  stepsByAct,
  resolveCurrent,
  nextStepAfter,
  planningDayName,
  addWeeks,
  type PlanningStep,
} from '../lib/api'
import { STEP_MODULES, type PlanningStepModule, type StepBodyProps } from './planning/registry'
import type { RecapPanelProps } from './planning/steps/RecapStep'
import { StepPlaceholder } from './planning/StepPlaceholder'
import { StepErrorBoundary } from './planning/StepErrorBoundary'
import { HandoffCtx, type HandoffAction } from './planning/handoff'
import { ParkedNoteEditor, type ParkedTag } from './planning/ParkedNoteEditor'
import '../styles/planning.css'

// Weekly Planning — the session shell: a step counter, a title, the step's ONE question and
// a 2px progress hair. The ten steps are reachable from the counter (the agenda sheet), not a
// permanent rail. Every step's BODY lives in its own component; this file owns the chrome,
// the lobby, the agenda sheet and the saved record. The step catalog comes from the server so
// this screen and iOS cannot drift.
//
// THE URL IS THE STATE: `/planning/:step` names the step, `?week=` the week — while the
// session's own `currentStep` is the cross-DEVICE resume pointer. The URL is where *this*
// browser is; the session row is where the *family* is.

function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const f = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  return `${f(start)} – ${f(end)}`
}

// Hoisted, NOT defined inside WeeklyPlanning: a component declared in the render body is a
// new component type on every render, so React remounts it and replaces its DOM nodes —
// dropping focus mid-interaction. Anything with a handler belongs out here.
function WeekStepper({ weekStart, canGoBack, busy, onGo, className }: {
  weekStart: string
  canGoBack: boolean
  busy: boolean
  onGo: (week: string) => void
  className?: string
}) {
  return (
    <div className={`wp-weeknav ${className ?? ''}`}>
      <button
        type="button" className="wp-weekarrow" disabled={!canGoBack || busy}
        onClick={() => onGo(addWeeks(weekStart, -1))}
        aria-label="Plan the previous week"
      >‹</button>
      <span className="wp-weeknav-l">{weekLabel(weekStart)}</span>
      <button
        type="button" className="wp-weekarrow" disabled={busy}
        onClick={() => onGo(addWeeks(weekStart, 1))}
        aria-label="Plan the next week"
      >›</button>
    </div>
  )
}

function DiscardBlock({ confirming, setConfirming, busy, onDiscard }: {
  confirming: boolean
  setConfirming: (v: boolean) => void
  busy: boolean
  onDiscard: () => void
}) {
  return (
    <div className="wp-sheet-danger">
      {confirming ? (
        <>
          <div className="wp-sheet-danger-q">
            Throw this session away and start the week over? What it already decided —
            events added, chores handed out — stays put; only the session is discarded.
          </div>
          <div className="wp-sheet-danger-acts">
            <button type="button" className="wp-sheet-danger-no" onClick={() => setConfirming(false)}>Keep it</button>
            <button type="button" className="wp-sheet-danger-yes" disabled={busy} onClick={onDiscard}>Start over</button>
          </div>
        </>
      ) : (
        <button type="button" className="wp-sheet-danger-open" onClick={() => setConfirming(true)}>Start this week over</button>
      )}
    </div>
  )
}

/**
 * A parked note handed to the step it was tagged for.
 *
 * THE SHELL OWNS THIS, not the ten steps: the banner is identical on every step, this
 * component already refetches the session view after every write (so a note dealt with
 * anywhere stops being offered everywhere), and each step's OWN affordances are what act on
 * the note. Three answers — "Handled" and "Drop it" both go through the resolve route;
 * leaving it alone writes nothing and the note turns up again in the recap. When the step
 * lends one, a third opens the STEP'S own composer (see `./handoff`) and settles the note
 * only if something was really created; a step with no composer lends nothing.
 */
function Handoff({ step, steps, sessionId, busy, onDone, action, onAct }: {
  step: PlanningStep
  /** Every step in the catalog — the tag list an edit may re-address a note to. */
  steps: PlanningStep[]
  sessionId: string
  busy: boolean
  onDone: () => void
  action: HandoffAction | null
  onAct: (id: string, note: string) => void
}) {
  const [working, setWorking] = useState<string | null>(null)
  const [hidden, setHidden] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)

  // EVERY STEP THIS HOUSEHOLD RUNS, except the note-triage step itself (the server refuses
  // that as a circle). Wider than the park bar's forward-only list on purpose: a correction
  // must not be narrower than the mistake. Titles come from the server-owned catalog.
  const tags: ParkedTag[] = useMemo(
    () => availableSteps(steps).filter((s) => s.key !== 'looseEnds').map((s) => ({ stepKey: s.key, label: s.title })),
    [steps]
  )

  const answer = async (id: string, action: 'done' | 'drop') => {
    if (working) return
    setWorking(id)
    try {
      await looseEndsApi.resolve('parked', id, action, sessionId)
              // Hidden locally as well as refetched: the refetch makes it true, this makes
              // it feel true before the round trip lands.
      setHidden((h) => [...h, id])
      onDone()
    } catch {
    } finally {
      setWorking(null)
    }
  }

  const notes = (step.parked ?? []).filter((n) => !hidden.includes(n.id))
  if (notes.length === 0) return null

  return (
    <div className="wp-handoff" data-testid="wp-handoff">
      <div className="wp-handoff-h">
        <span aria-hidden>📌</span>
        {notes.length === 1 ? 'You parked this for right here' : `You parked ${notes.length} things for right here`}
      </div>
      <ul className="wp-handoff-list">
        {notes.map((n) => (
          <li key={n.id} className="wp-handoff-row" data-testid={`wp-handoff-${n.id}`}>
            {editing === n.id ? (
              <ParkedNoteEditor
                id={n.id}
                note={n.note}
                stepKey={step.key}
                tags={tags}
                sessionId={sessionId}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null)
                  onDone()
                }}
              />
            ) : (
            <>
            <span className="wp-handoff-note">
              {n.note}
              {n.byline && <em>{n.byline}</em>}
            </span>
            <span className="wp-handoff-acts">
              <button
                type="button"
                className="btn btn-ghost wp-handoff-act"
                disabled={busy || working === n.id}
                onClick={() => setEditing(n.id)}
              >
                Edit
              </button>
              {action && (
                <button
                  type="button"
                  className="btn btn-primary wp-handoff-act is-make"
                  disabled={busy || working === n.id}
                  onClick={() => onAct(n.id, n.note)}
                >
                  {action.label}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost wp-handoff-act"
                disabled={busy || working === n.id}
                onClick={() => void answer(n.id, 'done')}
              >
                {action ? 'Already handled' : 'Handled'}
              </button>
              <button
                type="button"
                className="btn btn-ghost wp-handoff-act is-drop"
                disabled={busy || working === n.id}
                onClick={() => void answer(n.id, 'drop')}
              >
                Drop it
              </button>
            </span>
            </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * "I've stepped out of this session" — remembered on THIS DEVICE only.
 *
 * Coming back to `/planning` always resumes the active session (that is what lets another
 * device pick one up mid-way), so leaving has to record the intent somewhere — stored rather
 * than in the URL because it must survive tapping the Planning tab, which navigates to a
 * plain `/planning`. `sessionStorage`, not the server: "not right now" is one person at one
 * screen, and it is not a session status either — the session is untouched.
 */
const PAUSED_KEY = 'waffled.planning.pausedSession'
const readPaused = (): string | null => {
  // Storage can throw outright (private mode, blocked site data), and a session you cannot
  // pause beats a screen that will not render.
  try { return sessionStorage.getItem(PAUSED_KEY) } catch { return null }
}
const writePaused = (id: string | null) => {
  try {
    if (id) sessionStorage.setItem(PAUSED_KEY, id)
    else sessionStorage.removeItem(PAUSED_KEY)
  } catch { /* the pause is a convenience; losing it costs a resumed session */ }
}

export function WeeklyPlanning() {
  const { step: urlStep } = useParams<{ step?: string }>()
  const [search] = useSearchParams()
  const navigate = useNavigate()

  const weekParam = search.get('week') ?? undefined
  const { view, loading, refetch } = useWeeklyPlanning(weekParam)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // What the step wants kept on the record. A ref, not state: it only matters at the moment
  // the answer is sent, so keystrokes inside a step must not re-render the session.
  const decisionData = useRef<Record<string, unknown> | null>(null)
  const setDecisionData = useCallback((d: Record<string, unknown> | null) => { decisionData.current = d }, [])

  const steps = view?.steps ?? []
  const runnable = useMemo(() => availableSteps(steps), [steps])
  const current = useMemo(() => resolveCurrent(view ?? null, urlStep), [view, urlStep])
  const next = current ? nextStepAfter(steps, current.key) : null
  const session = view?.session ?? null
  const stepMod = useStepModule(current?.key)
  // Fetched here — above every early return — because the record is one of them. Capitalised
  // because it IS a component: a lowercase name in JSX is an HTML tag.
  const RecordRecap = useRecapPanel(session?.status === 'completed')

  const [handoffAction, setHandoffAction] = useState<HandoffAction | null>(null)
  const register = useCallback((a: HandoffAction | null) => setHandoffAction(a), [])
  // A ref, not state: nothing renders from it, and it must survive the re-render that
  // opening the composer causes.
  const acting = useRef<string | null>(null)
  const sessionId = session?.id ?? null

  const onAct = useCallback(
    (id: string, note: string) => {
      acting.current = id
      handoffAction?.run(note)
    },
    [handoffAction]
  )

  const finish = useCallback(
    (created: boolean) => {
      const id = acting.current
      acting.current = null
      if (!created || !id || !sessionId) return
      looseEndsApi
        .resolve('parked', id, 'done', sessionId)
        .then(() => refetch())
        .catch(() => {})
    },
    [sessionId, refetch]
  )

  const handoffCtx = useMemo(() => ({ register, finish }), [register, finish])


  useEffect(() => { decisionData.current = null }, [current?.key])

  const hrefFor = (stepKey: string | null, week?: string) => {
    const w = week ?? view?.weekStart
    const q = w && view && w !== view.defaultWeekStart ? `?week=${w}` : ''
    return `/planning${stepKey ? `/${stepKey}` : ''}${q}`
  }

  // "Stepped out" on this device, in state so leaving re-renders rather than needing a
  // navigation. Declared HERE, not beside `leave`: the URL-sync effect's dependency array
  // names it, and naming a `const` declared later in the body is a TDZ error.
  const [paused, setPaused] = useState<string | null>(() => readPaused())

  // While a week change is in flight the view we hold is about the OLD week, and acting on
  // it would shove the URL back to that week's step. Every correction below waits.
  const viewMatchesUrlWeek = !!view && view.weekStart === (weekParam ?? view.defaultWeekStart)

  // Keep the address bar honest. Corrections are driven by the VIEW and never fired
  // alongside a deliberate navigation — two routing updates racing in one tick put the URL
  // back on a step the session had just left. `replace` throughout: never a back-button stop.
  useEffect(() => {
    if (!view || !viewMatchesUrlWeek || !session) return
    if (session.status === 'completed') {
      if (urlStep) navigate(hrefFor(null), { replace: true })
      return
    }
    if (!current) return
    // STEPPED OUT: `/planning` is a destination now, not a path missing its step — without
    // this the correction below resumes a tick after "Leave for now" left.
    if (paused === session.id && !urlStep) return
    // A path naming a step that can't run resumes instead; a runnable one is left alone —
    // a pasted link outranks the pointer.
    if (!runnable.some((s) => s.key === urlStep)) navigate(hrefFor(current.key), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, viewMatchesUrlWeek, session?.id, session?.status, current?.key, urlStep, paused])

  // EVERY WRITE ON THIS SCREEN GOES THROUGH HERE, so this is the only place that can surface
  // a failure — without the catch, a rejected write redraws the screen as though it worked.
  // The refetch runs on the failure path too, deliberately: the server's answer is what
  // should show, and a half-happened write is when a stale local view misleads most.
  async function go(fn: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch {
      setError('That didn’t save. Check your connection and try again — nothing was lost.')
    } finally {
      setBusy(false)
      refetch()
    }
  }

  const start = () => go(async () => {
    const { session: s } = await weeklyPlanningApi.startSession(view?.weekStart)
    if (s?.currentStep) navigate(hrefFor(s.currentStep))
  })

  async function answer(status: 'done' | 'skipped') {
    if (!session || !current) return
    await go(async () => {
      await weeklyPlanningApi.decideStep(session.id, current.key, status, decisionData.current ?? undefined)
      decisionData.current = null
      if (next) {
        await weeklyPlanningApi.patchSession(session.id, { currentStep: next.key })
        navigate(hrefFor(next.key))
      } else {
        // No navigate: the effect above drops the step from the path once the completed
        // session arrives, so the URL can't get ahead of the state.
        await weeklyPlanningApi.complete(session.id)
      }
    })
  }

  const jump = (key: string) => {
    setSheet(false)
    if (!session) return
    navigate(hrefFor(key))
    go(() => weeklyPlanningApi.patchSession(session.id, { currentStep: key }))
  }

  // Start the week over. The lobby is otherwise unreachable once a session exists — coming
  // back to Planning always resumes — so without this a mistaken week could never be undone.
  const discard = () => {
    if (!session) return
    setSheet(false)
    setConfirmDiscard(false)
    go(async () => {
      await weeklyPlanningApi.discard(session.id)
      navigate(hrefFor(null), { replace: true })
    })
  }

  const closeSheet = () => { setSheet(false); setConfirmDiscard(false) }

  const leave = () => {
    setSheet(false)
    if (session) { writePaused(session.id); setPaused(session.id) }
    navigate(hrefFor(null))
  }

  const resume = () => {
    writePaused(null)
    setPaused(null)
    if (session?.currentStep) navigate(hrefFor(session.currentStep))
  }

  // Moving weeks drops the step: that week has its own session. ONE navigate, not a
  // setSearch plus a navigate — two routing updates in one tick race.
  const goWeek = (week: string) => {
    setSheet(false)
    if (!view) return
    navigate(week === view.defaultWeekStart ? '/planning' : `/planning?week=${week}`)
  }

  if (loading) return <div className="wp-screen"><div className="wp-empty">Loading…</div></div>
  if (!view) return <div className="wp-screen"><div className="wp-empty">Couldn't load the session — reload or sign in again.</div></div>

  if (!runnable.length) {
    return (
      <div className="wp-screen">
        <div className="wp-empty">
          Every step of the session reads a module that's turned off. Turn one back on in
          Settings → Modules, or turn individual steps on under Weekly Planning.
        </div>
      </div>
    )
  }

  const canGoBack = view.weekStart > view.minWeekStart
  const weekNav = { weekStart: view.weekStart, canGoBack, busy, onGo: goWeek }

  const discardProps = { confirming: confirmDiscard, setConfirming: setConfirmDiscard, busy, onDiscard: discard }

  // ── Saved: the record ────────────────────────────────────────────────────────
  if (session?.status === 'completed') {
    const decided = runnable.filter((s) => s.status !== 'pending')
    const recapStep = steps.find((s) => s.key === 'recap')
    const readBack = RecordRecap && recapStep
      ? <RecordRecap
          step={recapStep}
          sessionId={session.id}
          weekStart={view.weekStart}
          setDecisionData={NO_CRUMB}
          refresh={refetch}
          busy={busy}
          hrefForStep={(key) => RECORD_MODULE_HREF[key] ?? null}
        />
      : null
    return (
      <div className="wp-screen">
        <div className={`wp-record${readBack ? ' is-read' : ''}`}>
          <div className="wp-record-h">
            <div className="wp-record-t wf-serif">The week is decided</div>
            <div className="wp-record-s">
              {weekLabel(view.weekStart)} · saved {new Date(session.completedAt ?? session.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>
          {readBack && (
            <div className="wp-record-read">
              <StepErrorBoundary key="record-recap" title="the week">{readBack}</StepErrorBoundary>
            </div>
          )}
          {readBack && <div className="wp-record-steps">Step by step</div>}
          <div className="wp-record-list">
            {decided.map((s) => (
              <div key={s.key} className={`wp-record-row ${s.status}`}>
                <div className="wp-record-n">{s.status === 'done' ? '✓' : '–'}</div>
                <div className="wp-record-main">
                  <b>{s.title}</b>
                  <s>{s.status === 'done' ? s.primary : 'Skipped — a real answer'}</s>
                </div>
              </div>
            ))}
            {!decided.length && <div className="wp-record-row"><div className="wp-record-main"><s>Nothing was decided in this session.</s></div></div>}
          </div>
          <div className="wp-record-f">
            <button
              type="button" className="btn btn-ghost" disabled={busy}
              onClick={() => go(async () => {
                await weeklyPlanningApi.patchSession(session.id, { status: 'active' })
                if (session.currentStep) navigate(hrefFor(session.currentStep))
              })}
            >
              Reopen the session
            </button>
          </div>
          <div className="wp-record-week">Plan another week <WeekStepper {...weekNav} /></div>
          <DiscardBlock {...discardProps} />
        </div>
      </div>
    )
  }

  // ── Stepped out: the session is active, but not right now ───────────────────
  if (session?.status === 'active' && paused === session.id && !urlStep) {
    return (
      <div className="wp-screen">
        <div className="wp-lobby" data-testid="wp-paused">
          <div className="wp-lobby-t wf-serif">Left for now</div>
          <div className="wp-lobby-s">
            {weekLabel(view.weekStart)} is part-planned — {runnable.filter((x) => x.status !== 'pending').length} of{' '}
            {runnable.length} steps decided. Nothing was lost; pick it up whenever.
          </div>
          <button type="button" className="btn btn-primary wp-lobby-go" disabled={busy} onClick={resume}>
            Resume the session
          </button>
          <div className="wp-record-week">Plan another week <WeekStepper {...weekNav} /></div>
          <DiscardBlock {...discardProps} />
        </div>
      </div>
    )
  }

  // ── Lobby: no session yet ────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="wp-screen">
        <div className="wp-lobby">
          <div className="wp-lobby-t wf-serif">{planningDayName(view.config.dayOfWeek)}'s session</div>
          <div className="wp-lobby-s">{runnable.length} steps. Jump anywhere, leave whenever the week is decided.</div>
          <WeekStepper {...weekNav} className="wp-weeknav-lobby" />
          <div className="wp-lobby-acts">
            {stepsByAct(steps).map((a) => (
              <div key={a.act} className="wp-lobby-act">
                <div className="wp-lobby-act-h">{a.act}</div>
                <div className="wp-lobby-act-steps">{a.steps.map((s) => s.title).join(' · ')}</div>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-primary wp-lobby-go" disabled={busy} onClick={start}>
            Start the session
          </button>
        </div>
      </div>
    )
  }

  // ── In session ───────────────────────────────────────────────────────────────
  const pos = runnable.findIndex((s) => s.key === current?.key) + 1
  const pct = Math.round((pos / runnable.length) * 100)
  const stepProps: StepBodyProps | null = current
    ? { step: current, sessionId: session.id, weekStart: view.weekStart, setDecisionData, refresh: refetch, busy }
    : null

  return (
    <HandoffCtx.Provider value={handoffCtx}>
    <div className="wp-screen wp-in">
      <div className="wp-head">
        <button type="button" className="wp-stepchip" onClick={() => setSheet(true)} aria-expanded={sheet}>
          {pos} of {runnable.length}
          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div className="wp-title wf-serif">{current?.title}</div>
        <div className="wp-ask">{current?.ask}</div>
        <div className="wp-week">{weekLabel(view.weekStart)}</div>
        <button type="button" className="wp-exit" data-testid="wp-exit" onClick={leave}>
          Leave for now
        </button>
        <div className="wp-prog"><div style={{ width: `${pct}%` }} /></div>
      </div>

      {error && <div className="wp-err" role="alert">{error}</div>}

      <div className="wp-body">
        {/* `?? []` on purpose: a payload missing the field must cost the banner, never
            the whole session screen. The shell is the one component whose failure has
            nowhere to fall back to — there is no boundary above it. */}
        {current && (current.parked ?? []).length > 0 && (
          <Handoff
            step={current}
            steps={view.steps}
            sessionId={session.id}
            busy={busy}
            onDone={refetch}
            action={handoffAction}
            onAct={onAct}
          />
        )}
        {current && (
          // Keyed on the step so moving on retries rather than inheriting a failure.
          <StepErrorBoundary key={current.key} title={current.title}>
            {stepMod ? <stepMod.Body {...stepProps!} /> : <StepPlaceholder step={current} />}
          </StepErrorBoundary>
        )}
      </div>

      <div className="wp-foot">
        <button type="button" className="wp-skip" disabled={busy} onClick={() => answer('skipped')}>Skip this step</button>
        {stepMod?.FooterExtra && stepProps && <stepMod.FooterExtra {...stepProps} />}
        <div className="wp-foot-sp" />
        <button type="button" className="btn btn-primary wp-primary" disabled={busy} onClick={() => answer('done')}>
          {current?.primary}
          {next && <span className="wp-next">· next: {next.title}</span>}
        </button>
      </div>

      {sheet && (
        <div className="modal-overlay" onClick={closeSheet}>
          <div className="modal-card wp-sheet" data-testid="wp-sheet" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" onClick={closeSheet} aria-label="Close">×</button>
            <div className="wp-sheet-t wf-serif">{planningDayName(view.config.dayOfWeek)}'s session</div>
            <div className="wp-sheet-s">{runnable.length} steps. Jump anywhere, leave whenever the week is decided.</div>
            <WeekStepper {...weekNav} className="wp-weeknav-sheet" />
            {stepsByAct(steps).map((a) => (
              <div key={a.act}>
                <div className="wp-sheet-act">{a.act}</div>
                {a.steps.map((s) => {
                  const here = s.key === current?.key
                  const n = runnable.findIndex((x) => x.key === s.key) + 1
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={`wp-sheet-step${here ? ' on' : ''}${s.status === 'done' ? ' done' : ''}${s.status === 'skipped' ? ' skipped' : ''}`}
                      onClick={() => jump(s.key)}
                    >
                      <span className="wp-sheet-n">{s.status === 'done' ? '✓' : n}</span>
                      <span className="wp-sheet-name">{s.title}</span>
                      {here && <span className="wp-sheet-m">you're here</span>}
                      {!here && s.status === 'done' && <span className="wp-sheet-m">decided</span>}
                      {!here && s.status === 'skipped' && <span className="wp-sheet-m">skipped</span>}
                    </button>
                  )
                })}
              </div>
            ))}
            <div className="wp-sheet-f">
              <button type="button" className="btn btn-ghost" onClick={closeSheet}>Close</button>
              <button type="button" className="btn btn-ghost" onClick={leave}>Leave for now</button>
            </div>
            <DiscardBlock {...discardProps} />
          </div>
        </div>
      )}
    </div>
    </HandoffCtx.Provider>
  )
}

// WHERE A ROW ON THE FINISHED RECORD GOES — the MODULE the decision lives in, not the step
// that made it: the effect above force-drops the step from a completed session's path, so a
// `/planning/<step>` link would bounce straight back here. Changing a decision is "Reopen the
// session". Partial on purpose — a step whose decisions span several modules (loose ends,
// family night, kids) gets no href, because a row that looks tappable and isn't is worse.
const RECORD_MODULE_HREF: Record<string, string> = {
  calendar: '/calendar',
  meals: '/meals',
  tasks: '/tasks',
  goals: '/goals',
}

// Deliberately not through `useStepModule`: the registry's `Body` is typed for the step
// contract alone, and the record needs `hrefForStep` + `saved` as well.
function useRecapPanel(active: boolean): ComponentType<RecapPanelProps> | null {
  const [panel, setPanel] = useState<ComponentType<RecapPanelProps> | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    import('./planning/steps/RecapStep')
      .then((m) => { if (alive) setPanel(() => m.RecapPanel) })
      .catch(() => { /* the tick-list below is the fallback, and it is never not there */ })
    return () => { alive = false }
  }, [active])
  return panel
}

// A module-level constant: the record cannot answer a step, and an inline `() => {}` would
// re-fire the panel's effect on every render.
const NO_CRUMB = () => {}

function useStepModule(key: string | undefined): PlanningStepModule | null {
  const [mod, setMod] = useState<PlanningStepModule | null>(null)
  useEffect(() => {
    let alive = true
    setMod(null)
    const load = key ? STEP_MODULES[key] : undefined
    if (!load) return
    load().then((m) => { if (alive) setMod(m) }).catch(() => { /* falls back to the placeholder */ })
    return () => { alive = false }
  }, [key])
  return mod
}
