import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  planningKidsApi,
  planningKidsDecision,
  goalDisplayProgress,
  goalDisplayTarget,
  fmtGoalNum,
  type PlanningKidsView,
  type PlanningKidCard,
  type PlanningKidFocusOption,
  type PlanningKidForwardOption,
  type PlanningKidPick,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-kids.css'

// Step 9 · Kids — "What's your week about?"
//
// THE ONE STEP THE KIDS THEMSELVES READ: the type is sized for them, their NAME is the title of
// their card, and both cards fit one screen. On a phone a segmented control puts one kid on
// screen at a time; both cards stay in the DOM and CSS decides, so there is one layout to keep
// right.
//
//
// WHY THERE IS A STORE IN THIS FILE: the shell renders `Body` and `FooterExtra` as two sibling
// trees, and the footer's "Same as last week" / "Change something" is what the body reacts to.
// Module-scoped and keyed by session+week, so another week can't inherit these answers.
//
// The answers are a REAL write, never `setDecisionData` — the crumb only reaches the server
// when the step is ANSWERED, so a family that read the cards out and walked away would lose the
// very thing they came here to say.

interface StepState {
  key: string
  view: PlanningKidsView | null
  loading: boolean
  error: string | null
  saving: string | null
  active: string | null
  changing: boolean
  typing: { personId: string; which: 'focus' | 'forward' } | null
  drafts: Record<string, string>
}

const EMPTY: StepState = { key: '', view: null, loading: true, error: null, saving: null, active: null, changing: false, typing: null, drafts: {} }

let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

async function load(key: string, sessionId: string, weekStart: string) {
  set({ ...EMPTY, key })
  try {
    const view = await planningKidsApi.get(sessionId, weekStart)
    if (state.key !== key) return // a later week won the race
    set({ view, loading: false, active: view.kids[0]?.personId ?? null })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read the kids' week — reload, or skip this step." })
  }
}

async function reread(sessionId: string, weekStart: string) {
  const key = state.key
  const view = await planningKidsApi.get(sessionId, weekStart)
  if (state.key === key) set({ view })
}

function useKidsStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  useEffect(() => {
    if (state.key !== key) void load(key, p.sessionId, p.weekStart)
    else if (primary && !state.loading) void reread(p.sessionId, p.weekStart).catch(() => { /* the cards stay as they were */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useSyncExternalStore(subscribe, snapshot)
}

async function answer(p: StepBodyProps, personId: string, body: { focus?: PlanningKidPick; forward?: PlanningKidPick }) {
  if (state.saving || p.busy) return
  set({ saving: personId, error: null, typing: null })
  try {
    const view = await planningKidsApi.answer(p.sessionId, personId, body, p.weekStart)
    set({ view, saving: null, changing: false })
  } catch {
    set({ saving: null, error: "That didn't take — try again." })
  }
  p.refresh()
}


function heading(kids: PlanningKidCard[]): string {
  const names = kids.map((k) => k.name)
  if (names.length <= 1) return names[0] ?? 'Kids'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const readBackNow = (s: StepState) =>
  !s.changing && !!s.view && s.view.kids.length > 0 && s.view.kids.every((k) => k.settled)

function Face({ kid, className }: { kid: PlanningKidCard; className: string }) {
  return (
    <span className={className} style={{ background: `${kid.colorHex ?? '#A6A29B'}22` }} aria-hidden>
      {kid.avatarEmoji ?? '🙂'}
    </span>
  )
}

function FocusOption({ option, checked, disabled, onPick }: {
  option: PlanningKidFocusOption
  checked: boolean
  disabled: boolean
  onPick: () => void
}) {
  // The number ALWAYS comes from the shared helper — never an inline `totalProgress`, which
  // would tell a kid they'd read 99 times this week. `detail` is null on a standing chore
  // because nothing is wrong with it: that absence is the design, not a missing string.
  const progress = option.goal ? goalDisplayProgress(option.goal) : null
  const target = option.goal ? goalDisplayTarget(option.goal) : null
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`wpk-opt${checked ? ' on' : ''}`}
      onClick={onPick}
    >
      <span className="wpk-opt-e" aria-hidden>{option.emoji}</span>
      <span className="wpk-opt-main">
        <span className="wpk-opt-t">{option.label}</span>
        {option.detail && <span className="wpk-opt-s">{option.detail}</span>}
        {option.routed && <span className="wpk-routed">sent here in step 1</span>}
      </span>
      {progress != null && (
        <span className="wpk-opt-num">
          <span className="wpk-num">{fmtGoalNum(progress)}</span>
          {target != null && <span className="wpk-den">/ {fmtGoalNum(target)}</span>}
        </span>
      )}
    </button>
  )
}

function ForwardOption({ option, checked, disabled, onPick }: {
  option: PlanningKidForwardOption
  checked: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`wpk-fchip${checked ? ' on' : ''}`}
      onClick={onPick}
    >
      <span aria-hidden>{option.emoji}</span>
      <span className="wpk-fchip-n">{option.when} · {option.label}</span>
    </button>
  )
}

function TypeIn({ label, placeholder, initial, disabled, onCancel, onSave, onDraft }: {
  label: string
  placeholder: string
  initial: string
  disabled: boolean
  onCancel: () => void
  onSave: (text: string) => void
  onDraft: (text: string) => void
}) {
  const [text, setText] = useState(initial)
  const latest = useRef(text)
  latest.current = text
  // Called ONCE, as the box goes away: writing the draft per keystroke would re-render every
  // card in the step to move a cursor.
  useEffect(() => () => onDraft(latest.current), [])
  return (
    <form
      className="wpk-type"
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSave(text.trim()) }}
    >
      <label className="field wpk-type-f">
        <input
          aria-label={label}
          placeholder={placeholder}
          value={text}
          autoFocus
          maxLength={120}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>Save</button>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

function Card({ kid, s, p, readBack }: { kid: PlanningKidCard; s: StepState; p: StepBodyProps; readBack: boolean }) {
  const frozen = p.busy || s.saving !== null
  const typing = s.typing?.personId === kid.personId ? s.typing.which : null

  return (
    <section
      className={`wpk-card${s.active === kid.personId ? ' on' : ''}`}
      role="group"
      aria-label={kid.name}
    >
      <header className="wpk-h">
        <Face kid={kid} className="wpk-face" />
        <div className="wpk-id">
          <div className="wpk-nm">{kid.name}</div>
          {kid.age != null && <div className="wpk-ag">age {kid.age}</div>}
        </div>
        {kid.stars != null && (
          <div className="wpk-stars">{kid.starsSymbol ?? '⭐'} {kid.stars}</div>
        )}
      </header>

      <div className="wpk-sec">
        <div className="wpk-lab">Your week</div>
        <ul className="wpk-chips" aria-label={`${kid.name}’s week`}>
          {kid.week.map((e) => (
            <li key={e.id} className="wpk-chip">
              <span className="wpk-chip-t">{e.when}</span>
              <span className="wpk-chip-n">{e.title}</span>
            </li>
          ))}
          {kid.chores.map((c) => (
            <li key={`c-${c.id}`} className={`wpk-chip${c.late ? ' late' : ''}`}>
              <span className="wpk-chip-t">{c.when}</span>
              <span className="wpk-chip-n">{c.title}</span>
            </li>
          ))}
          {kid.week.length === 0 && kid.chores.length === 0 && (
            <li className="wpk-chip"><span className="wpk-chip-n">Nothing on it yet</span></li>
          )}
        </ul>
      </div>

      {readBack ? (
        <div className="wpk-sec" role="region" aria-label={`What ${kid.name} said`}>
          {kid.focus && (
            <div className="wpk-said">
              <div className="wpk-said-e" aria-hidden>{kid.focus.emoji}</div>
              <div className="wpk-said-b">
                <div className="wpk-big">{kid.focus.label}</div>
                <div className="wpk-cap">this week’s one thing</div>
              </div>
            </div>
          )}
          {kid.forward && (
            <div className="wpk-said">
              <div className="wpk-said-e" aria-hidden>{kid.forward.emoji}</div>
              <div className="wpk-said-b">
                <div className="wpk-big">{kid.forward.label}</div>
                <div className="wpk-cap">
                  {kid.forward.when ? `${kid.forward.when} — ` : ''}the bit to look forward to
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="wpk-sec">
            <div className="wpk-lab">One thing to focus on</div>
            <div className="wpk-opts" role="radiogroup" aria-label={`${kid.name}’s one thing`}>
              {kid.focusOptions.map((o) => (
                <FocusOption
                  key={o.key}
                  option={o}
                  checked={kid.focus?.source === o.source && kid.focus?.id === o.id}
                  disabled={frozen}
                  onPick={() => void answer(p, kid.personId, { focus: { key: o.key } })}
                />
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={kid.focus?.source === 'custom'}
                disabled={frozen}
                className={`wpk-opt ${kid.focus?.source === 'custom' ? 'on wpk-opt-own' : 'more'}`}
                onClick={() => set({ typing: { personId: kid.personId, which: 'focus' } })}
              >
                {kid.focus?.source === 'custom' ? kid.focus.label : '＋ Something else'}
              </button>
            </div>
            {typing === 'focus' && (
              <TypeIn
                label={`Something else for ${kid.name}`}
                placeholder="In their own words"
                initial={s.drafts[`${kid.personId}:focus`] ?? (kid.focus?.source === 'custom' ? kid.focus.label : '')}
                disabled={frozen}
                onCancel={() => set({ typing: null })}
                onDraft={(text) => set({ drafts: { ...state.drafts, [`${kid.personId}:focus`]: text } })}
                onSave={(text) => void answer(p, kid.personId, { focus: { text } })}
              />
            )}
          </div>

          <div className="wpk-sec">
            <div className="wpk-lab">Something to look forward to</div>
            <div className="wpk-fwd" role="radiogroup" aria-label={`what ${kid.name} is looking forward to`}>
              {kid.forwardOptions.map((o) => (
                <ForwardOption
                  key={o.key}
                  option={o}
                  checked={kid.forward?.eventId === o.eventId}
                  disabled={frozen}
                  onPick={() => void answer(p, kid.personId, { forward: { key: o.key } })}
                />
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={kid.forward?.eventId === null && kid.forward != null}
                disabled={frozen}
                className={`wpk-fchip ${kid.forward != null && kid.forward.eventId === null ? 'on wpk-fchip-own' : 'more'}`}
                onClick={() => set({ typing: { personId: kid.personId, which: 'forward' } })}
              >
                {kid.forward != null && kid.forward.eventId === null ? kid.forward.label : '＋ Add something'}
              </button>
            </div>
            {typing === 'forward' && (
              <TypeIn
                label={`Something else for ${kid.name} to look forward to`}
                placeholder="Something on their week"
                initial={s.drafts[`${kid.personId}:forward`] ?? (kid.forward != null && kid.forward.eventId === null ? kid.forward.label : '')}
                disabled={frozen}
                onCancel={() => set({ typing: null })}
                onDraft={(text) => set({ drafts: { ...state.drafts, [`${kid.personId}:forward`]: text } })}
                onSave={(text) => void answer(p, kid.personId, { forward: { text } })}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function Body(p: StepBodyProps) {
  const s = useKidsStep(p, true)
  const { setDecisionData } = p

  // Mirror what the session knows onto the crumb after EVERY fresh read, not only after a
  // click: the shell RESETS the crumb on step change and replaces the step's stored data when
  // the primary is pressed.
  useEffect(() => { if (s.view) setDecisionData(planningKidsDecision(s.view)) }, [s.view, setDecisionData])

  if (s.loading) return <div className="wpk-note">Reading their week…</div>
  if (s.error && !s.view) return <div className="wpk-note">{s.error}</div>

  const kids = s.view?.kids ?? []
  if (kids.length === 0) {
    return (
      <div className="wpk-note">
        No one in this household is set up as a child yet, so there are no cards to read
        out. Add them in Settings → People (member type “kid”) and this step will have
        something to ask — skipping is a real answer in the meantime.
      </div>
    )
  }

  const readBack = readBackNow(s)
  return (
    <div className="wpk">
      <h2 className="wpk-title">{heading(kids)}</h2>

      <div className="wpk-tabs" role="tablist" aria-label="Which kid">
        {kids.map((k) => (
          <button
            key={k.personId}
            type="button"
            role="tab"
            aria-selected={s.active === k.personId}
            className={`wpk-tab${s.active === k.personId ? ' on' : ''}`}
            onClick={() => set({ active: k.personId })}
          >
            <Face kid={k} className="wpk-tab-face" />
            <span className="wpk-tab-n">{k.name}</span>
            {k.settled && <span aria-hidden>★</span>}
          </button>
        ))}
      </div>

      {s.error && <div className="wpk-note">{s.error}</div>}

      <div className="wpk-cards">
        {kids.map((k) => (
          <Card key={k.personId} kid={k} s={s} p={p} readBack={readBack} />
        ))}
      </div>
    </div>
  )
}

function FooterExtra(p: StepBodyProps) {
  const s = useKidsStep(p)
  if (!s.view || s.view.kids.length === 0) return null
  if (readBackNow(s)) {
    return (
      <button type="button" className="btn btn-ghost" onClick={() => set({ changing: true })}>
        Change something
      </button>
    )
  }
  if (!s.view.canRepeat) return null
  return (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={p.busy || s.saving !== null}
      onClick={() => {
        if (state.saving || p.busy) return
        set({ saving: 'repeat', error: null })
        planningKidsApi.repeat(p.sessionId, p.weekStart)
          .then((view) => set({ view, saving: null, changing: false }))
          .catch(() => set({ saving: null, error: "Couldn't copy last week — pick this week's instead." }))
          .finally(() => p.refresh())
      }}
    >
      Same as last week
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
