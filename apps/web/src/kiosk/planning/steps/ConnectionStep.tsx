import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  usePersons,
  planningConnectionApi,
  type Person,
  type PlanningConnectionBoard,
  type PlanningConnectionEvent,
  type PlanningConnectionPairing,
  type PlanningConnectionSlot,
} from '../../../lib/api'
import { EventModal } from '../../components/EventModal'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-connection.css'

// Step 5 · Connection — "Who gets time with whom?"
//
// NOTHING NEW IS STORED FOR THIS STEP. A pairing is a query over event_participants and claiming a
// slot writes an ORDINARY CALENDAR EVENT. This file must never grow a pairing record: a row's state
// is whatever the calendar says next time you look, so every action re-reads.
//
// Four rules this file must not break:
//  1. THE ROWS ARE A PROMPT, NOT THE LIST, with "Make a pairing" first-class beneath them.
//  2. TIME THAT ALREADY EXISTS GETS CREDIT — a tool that can only add obligations is worse.
//  3. ADDING IS THE APP'S OWN EVENT MODAL. This step keeps only what the modal CAN'T do: choosing
//     who, and picking one of the week's real gaps.
//  4. NO INVENTED TIMES. A slot is a server-computed gap; a day with nothing on it has NO time and
//     `EventModal`'s own picker decides.

// How many pairings the step shows — a layout decision. One with time on the week is kept first.
const ROWS = 3
// How many of a pairing's gaps fit on a row before "Another time" takes over.
const SLOTS = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 8". Local parse (no trailing Z) so the date doesn't slip a day west of Greenwich. */
function monthDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "2 hours" / "45 minutes" — how long the thing they already have actually runs. */
function durationWords(min: number): string {
  if (min % 60 === 0) {
    const h = min / 60
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return `${min} minutes`
}

/**
 * Which pairings the step draws, IN THE SERVER'S OWN ORDER.
 *
 * `slice(0, ROWS)` must never hide a pairing you have just given time to: the ranking reads only
 * history BEFORE the planned week, and a row you cannot see is indistinguishable from a write that
 * never happened. Filtered, not partitioned — re-grouping would throw the ranking away.
 */
export function visible<T extends { alreadyThisWeek: unknown[] }>(pairings: T[]): T[] {
  const credited = pairings.filter((p) => p.alreadyThisWeek.length)
  let guesses = Math.max(0, ROWS - credited.length)
  const keep = new Set(credited)
  for (const p of pairings) {
    if (guesses <= 0) break
    if (keep.has(p)) continue
    keep.add(p)
    guesses -= 1
  }
  return pairings.filter((p) => keep.has(p))
}

/** "20:30" for EventModal's time field, from the instant the gap opens. */
function localTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * EVERY event this week with both of them on it — the candidate list for "Link a time", and
 * precisely `alreadyThisWeek ∪ togetherThisWeek`, hence no new read.
 */
export const bothOnIt = (p: PlanningConnectionPairing): PlanningConnectionEvent[] =>
  [...p.alreadyThisWeek, ...p.togetherThisWeek]

export function pairingSentence(p: PlanningConnectionPairing, linkedId: string | null): string {
  // A LINKED event answers the pairing whatever else the week says, so it is looked up across
  // both lists rather than assumed to be `alreadyThisWeek[0]`.
  const linked = linkedId ? bothOnIt(p).find((e) => e.id === linkedId) : undefined
  if (linked) return `Nothing new — ${linked.day}’s ${linked.title} already is it, and you said so out loud.`
  const credit = p.alreadyThisWeek[0]
  if (credit) {
    const len = credit.minutes ? ` for ${durationWords(credit.minutes)}` : ''
    return `${credit.day}’s ${credit.title} is the two of you${len} — that may already be it.`
  }
  const lead = `Nothing on the calendar with just the two of you${p.lastTogetherOn ? ` since ${monthDay(p.lastTogetherOn)}` : ''}.`
  const near = p.togetherThisWeek
  if (near.length === 1) return `${lead} ${near[0].day}’s ${near[0].title} is you both, but it’s not that.`
  if (near.length > 1) return `${lead} You’re both at ${near.length} things this week, but none of them is that.`
  return lead
}

/** What a slot chip hands the event modal: the day, and the time only when there is one. */
interface Compose {
  date: string
  time?: string
  participantIds: string[]
}
const composeFrom = (slot: PlanningConnectionSlot, participantIds: string[]): Compose => ({
  date: slot.date,
  time: slot.startsAt ? localTime(slot.startsAt) : undefined,
  participantIds,
})

// A person's face. Identity, not a control — the same tint the Tasks step's `.wpt-face` paints.
function Face({ person }: { person: Person }) {
  return (
    <span className="wpn-face" style={{ background: `${person.colorHex ?? '#A6A29B'}22` }} aria-hidden>
      {person.avatarEmoji ?? '🙂'}
    </span>
  )
}

// How long to keep asking the server after a save.
//
// THE WRITE IS LOCAL-FIRST; THIS BOARD IS A SERVER READ. `EventModal` saves through PowerSync and
// uploads afterwards, so when `onSaved` fires the server has not been told yet and re-reading once
// looks exactly like a lost save. So ask again on a widening ladder, stopping when the credit
// count goes UP. Deliberately NOT a second source of truth: this step's contract is that the
// SERVER composes the row's sentence.
const CATCHUP_MS = [250, 500, 1000, 2000, 3000]

const credited = (b: PlanningConnectionBoard | null) =>
  (b?.pairings ?? []).reduce((n, p) => n + p.alreadyThisWeek.length, 0)

function Body({ step, sessionId, weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const { persons } = usePersons()
  const [board, setBoard] = useState<PlanningConnectionBoard | null>(null)
  const [error, setError] = useState(false)
  // COUNTS only: the crumb is a hint for the recap, never storage.
  const [added, setAdded] = useState(0)
  // WHICH EVENT ANSWERS EACH PAIRING, keyed by the pairing's people → event id. Not local state:
  // it is seeded from the step's record and written back.
  const [links, setLinks] = useState<Record<string, string>>(
    () => ((step.data as { links?: Record<string, string> } | null)?.links ?? {})
  )
  const [picking, setPicking] = useState<string | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null)

  const load = useCallback(() => {
    planningConnectionApi
      .board(weekStart)
      .then((b) => { setBoard(b); setError(false) })
      .catch(() => setError(true))
  }, [weekStart])
  useEffect(load, [load])

  // RE-ARMED IN THE EFFECT BODY, not only cleared on unmount: StrictMode mounts, cleans up, then
  // mounts again, which would leave this false for the life of the real mount.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // Written through the step's own MID-STEP route, which merges the map and leaves
  // `status`/`decided_at` alone: linking a time is not answering the step, and `setDecisionData`
  // alone only reaches the server when it is.
  const remember = useCallback(
    (next: Record<string, string>) => {
      planningConnectionApi
        .saveLinks(sessionId, next)
        // The link is already on screen; a failed write costs the memory of it, not the sitting.
        .catch(() => {})
    },
    [sessionId]
  )

  const link = useCallback(
    (key: string, eventId: string | null) => {
      setLinks((cur) => {
        const next = { ...cur }
        if (eventId === null || next[key] === eventId) delete next[key]
        else next[key] = eventId
        remember(next)
        return next
      })
      setPicking(null)
    },
    [remember]
  )

  const settle = useCallback(async (was: number, autoLink?: { key: string; before: Set<string> }) => {
    for (let i = 0; i <= CATCHUP_MS.length; i++) {
      try {
        const b = await planningConnectionApi.board(weekStart)
        if (!alive.current) return
        setBoard(b)
        setError(false)
        if (credited(b) > was) {
          // THE EVENT YOU JUST MADE IS THE ANSWER TO THAT PAIRING, answered by DIFFERENCE: the
          // shared modal's `onSaved` takes no argument and the write is local-first, so the only
          // id certainly belonging to the server is the one that appeared since we looked.
          if (autoLink) {
            const pair = b.pairings.find((p) => p.personIds.join('-') === autoLink.key)
            const fresh = pair?.alreadyThisWeek.find((e) => !autoLink.before.has(e.id))
            if (fresh) link(autoLink.key, fresh.id)
          }
          return
        }
      } catch {
        if (alive.current) setError(true)
        return
      }
      const wait = CATCHUP_MS[i]
      if (wait === undefined) return
      await new Promise((r) => setTimeout(r, wait))
      if (!alive.current) return
    }
  }, [weekStart, link])

  useEffect(() => {
    if (!board) return
    setDecisionData({ added, alreadyCounted: Object.keys(links).length, links })
  }, [board, added, links, setDecisionData])

  const byId = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons])

  function onSaved() {
    setAdded((n) => n + 1)
    // Read BEFORE the re-read, so the difference afterwards names the event just created.
    const key = compose ? compose.participantIds.join('-') : null
    const row = key ? board?.pairings.find((p) => p.personIds.join('-') === key) : undefined
    const autoLink = key && row ? { key, before: new Set(row.alreadyThisWeek.map((e) => e.id)) } : undefined
    // Re-read, and keep asking until the answer includes the event just written. See `CATCHUP_MS`.
    void settle(credited(board), autoLink)
    refresh()
  }

  if (error) return <p className="wpn-empty">Couldn’t read your week just now.</p>
  if (!board) return <p className="wpn-empty">Looking at who’s been where…</p>
  if (!board.pairings.length) {
    return <p className="wpn-empty">This one needs more than one person in the household — add someone in Settings, and pairings appear here.</p>
  }

  return (
    <div className="wpn">
      {visible(board.pairings).map((p) => {
        const key = p.personIds.join('-')
        const people = p.personIds.map((id) => byId.get(id)).filter(Boolean) as Person[]
        const linkedId = links[key] ?? null
        const candidates = bothOnIt(p)
        // THE ANSWER and the one-tap offer are two different things, or two chips read as chosen
        // at once. `oneTap` is NOT `alreadyThisWeek[0]`, which is just the first of several.
        const answer = linkedId ? candidates.find((e) => e.id === linkedId) ?? null : null
        const oneTap = answer ?? (candidates.length === 1 ? candidates[0]! : null)
        return (
          <div className="wpn-row" key={key} data-testid={`wpn-pair-${key}`}>
            <div className="wpn-faces" role="img" aria-label={p.who}>
              {people.map((person) => <Face key={person.id} person={person} />)}
            </div>

            <div className="wpn-main">
              <div className="wpn-who">{p.who}</div>
              <p className="wpn-stat">{pairingSentence(p, linkedId)}</p>
            </div>

            <div className="wpn-slots">
              {/* Time that already exists, first and muted — the only answer that costs nobody an
                  evening. IT NAMES THE EVENT: a day and an hour identify nothing. */}
              {oneTap && (
                <button
                  type="button"
                  className={`wpn-slot wpn-counts${answer ? ' on' : ''}`}
                  aria-pressed={answer !== null}
                  aria-label={`${oneTap.title} on ${oneTap.when} ${answer ? 'is your time together' : 'already counts'}`}
                  disabled={busy}
                  onClick={() => link(key, oneTap.id)}
                >
                  {answer ? '✓ ' : ''}{oneTap.title} · {oneTap.day.slice(0, 3)}
                </button>
              )}

              {/* An evening where the two are both there ALONGSIDE somebody else was only ever a
                  sentence with no way to point at it. NEVER in the chosen state: exactly one chip
                  per row says "this is the answer". */}
              {candidates.length > (oneTap ? 1 : 0) && (
                <button
                  type="button"
                  className="wpn-slot wpn-link"
                  aria-expanded={picking === key}
                  aria-label={`${answer ? 'Change the time' : 'Link a time'} for ${p.who}`}
                  disabled={busy}
                  onClick={() => setPicking((cur) => (cur === key ? null : key))}
                >
                  {answer ? 'Change' : 'Link a time'}
                </button>
              )}

              {p.slots.slice(0, SLOTS).map((s) => (
                <button
                  key={s.date}
                  type="button"
                  className="wpn-slot"
                  disabled={busy}
                  onClick={() => setCompose(composeFrom(s, p.personIds))}
                >
                  {s.label}
                </button>
              ))}

              <button
                type="button"
                className="wpn-slot wpn-add"
                aria-label={`Another time for ${p.who}`}
                disabled={busy}
                onClick={() => setCompose({ date: weekStart, participantIds: p.personIds })}
              >
                <span aria-hidden>＋</span> Another time
              </button>
            </div>

            {/* Named by WHEN they are. Picking the one already linked unlinks it. */}
            {picking === key && (
              <div className="wpn-link-list" data-testid={`wpn-link-${key}`} role="group" aria-label={`Time ${p.who} already share`}>
                {candidates.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={`wpn-link-opt${linkedId === e.id ? ' on' : ''}`}
                    aria-pressed={linkedId === e.id}
                    disabled={busy}
                    onClick={() => link(key, e.id)}
                  >
                    <b>{e.title}</b>
                    <span>{e.when}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <MakePairing weekStart={weekStart} persons={persons} busy={busy} onCompose={setCompose} />

      <p className="wpn-note">
        The rows above are just the pairings the app can see — they aren’t the list.{' '}
        <b>Make a pairing</b> takes any two people and any time, and the slots offered are the gaps the
        week already left behind. Either way it ends up as a normal calendar event. Add a third person
        and it still lands on the calendar — it just counts as time together rather than as time with
        just the two of them.
      </p>

      {/* The app's own event modal — NOT a second event form. It carries the people and the gap. */}
      {compose && (
        <EventModal
          date={compose.date}
          time={compose.time}
          prefill={{ participantIds: compose.participantIds }}
          onClose={() => setCompose(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/**
 * "＋ Make a pairing" — the first-class action, at full width under the rows. Choosing WHO is the
 * input to the slot query and the prefill for the modal, not an event form: what, when and the
 * save all belong to `EventModal`.
 */
function MakePairing({
  weekStart,
  persons,
  busy,
  onCompose,
}: {
  weekStart: string
  persons: Person[]
  busy: boolean
  onCompose: (c: Compose) => void
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [slots, setSlots] = useState<PlanningConnectionSlot[]>([])
  const [who, setWho] = useState('')

  // Household order, not tap order — so the same three people always ask the same question.
  const chosen = useMemo(() => persons.filter((p) => picked.has(p.id)).map((p) => p.id), [persons, picked])

  // Keyed on the ids THEMSELVES: a fresh `persons` array would loop /slots forever.
  const key = chosen.join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    if (ids.length < 2) { setSlots([]); setWho(''); return }
    let live = true
    planningConnectionApi
      .slotsFor(weekStart, ids)
      .then((r) => { if (live) { setSlots(r.slots); setWho(r.who) } })
      .catch(() => { if (live) { setSlots([]); setWho('') } })
    return () => { live = false }
  }, [weekStart, key])

  if (!open) {
    return (
      <button type="button" className="wpn-make-open" disabled={busy} onClick={() => setOpen(true)}>
        <span className="wpn-make-lead">
          <span aria-hidden>＋</span> Make a pairing — any two people, any time
        </span>
        <span className="wpn-faces" aria-hidden>
          {persons.map((p) => <Face key={p.id} person={p} />)}
        </span>
      </button>
    )
  }

  return (
    <div className="wpn-make" data-testid="wpn-make">
      <div className="wpn-make-row">
        <div className="wpn-lab">Who</div>
        <div className="wpn-picks">
          {persons.map((p) => {
            const on = picked.has(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`wpn-face wpn-pick${on ? ' on' : ''}`}
                style={{ background: `${p.colorHex ?? '#A6A29B'}22`, borderColor: on ? (p.colorHex ?? undefined) : undefined }}
                aria-pressed={on}
                aria-label={on ? `${p.name} — take out of the pairing` : `${p.name} — add to the pairing`}
                disabled={busy}
                onClick={() =>
                  setPicked((cur) => {
                    const next = new Set(cur)
                    if (!next.delete(p.id)) next.add(p.id)
                    return next
                  })
                }
              >
                {p.avatarEmoji ?? '🙂'}
              </button>
            )
          })}
        </div>
        <div className="wpn-picked">{who ? `${who} · tap to add anyone else` : 'Tap two people — or three.'}</div>
      </div>

      <div className="wpn-make-row">
        <div className="wpn-lab">When</div>
        <div className="wpn-slots wpn-slots-left">
          {chosen.length < 2 ? (
            <span className="wpn-hint">Their free evenings appear once there are two of them.</span>
          ) : (
            <>
              {slots.slice(0, SLOTS + 1).map((s) => (
                <button
                  key={s.date}
                  type="button"
                  className="wpn-slot"
                  disabled={busy}
                  onClick={() => onCompose(composeFrom(s, chosen))}
                >
                  {s.label}
                </button>
              ))}
              {/* "Any time" has to mean any time — this one opens the modal on its own picker. */}
              <button
                type="button"
                className="wpn-slot wpn-add"
                disabled={busy}
                onClick={() => onCompose({ date: weekStart, participantIds: chosen })}
              >
                Pick a date and time
              </button>
            </>
          )}
        </div>
      </div>

      <div className="wpn-make-row">
        <div className="wpn-lab" />
        <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setPicked(new Set()) }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// No FooterExtra: the shell already owns "Done" and "Nothing this week", both honest answers.
const mod: PlanningStepModule = { Body }
export default mod
