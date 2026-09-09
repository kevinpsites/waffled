import { useCallback, useEffect, useRef, useState } from 'react'
import { avTint } from '../../components/Avatar'
import { Icon } from '../../icons'
import { ChoreModal } from '../../components/ChoreModal'
import { useHandoffAction } from '../handoff'
import {
  can,
  useCurrencies,
  useHousehold,
  planningTasksApi,
  type PlanningTasksBoard,
  type PlanningTasksChore,
  type PlanningTasksPerson,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-tasks.css'

// Step 8 · Tasks — "Who's doing what?"
//
// Laid out by person, in the kiosk Chores screen's own columns. Everything nobody has
// taken sits in one strip with the member faces under it; tap nobody and it stays up for
// grabs, a real answer and not an error state. EVERY MOVE IS REVERSIBLE, and both
// directions move the chore DEFINITION and every open day of it already on a kiosk
// board, so the two screens can never disagree. A COLUMN IS THE WEEK, NOT THE SITTING:
// its contents come from the server read, so handing a chore out re-reads rather than
// bookkeeping locally. Every write goes through existing chores endpoints.

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function shortTime(hhmm: string | null): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return ''
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

const weekdayOf = (iso: string) => SHORT_DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]
const monthDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function dayChip(c: PlanningTasksChore): string {
  const time = shortTime(c.dueTime)
  const withTime = (s: string) => (time ? `${s} ${time}` : s)
  if (c.carriedOver) return withTime('Carried over')
  if (c.days.length >= 7) return withTime('Every day')
  if (c.days.length > 0) return withTime(c.days.map(weekdayOf).join(', '))
  if (c.dueOn) return withTime(monthDay(c.dueOn))
  return 'No day set'
}

// A one-off's day can be moved (it lives on the single instance the chores module
// materialized); a recurring chore's days come from its rrule and belong to the editor.
const dayIsSettable = (c: PlanningTasksChore) => c.cadence === 'once'

function provenance(c: PlanningTasksChore): string {
  if (c.carriedOver) return 'Left over from before this week'
  return c.cadence === 'once' ? 'One-off task' : 'Recurring chore'
}

function carriesLabel(n: number): string {
  if (n === 0) return 'No recurring chores yet'
  return `Carries ${n} recurring chore${n === 1 ? '' : 's'}`
}

// One card, and FOUR regions that must never be mistaken for each other: the grip starts a
// drag and only a drag (it preventDefaults, so no click fires behind it); the day chip
// opens the day picker; the faces hand it over or take it back; the title block opens the
// app's own chore editor. They are SIBLINGS, not nested — the editor's tap target is its
// own button around the title rather than the whole card body, so no click has to be
// stopped from reaching a parent and no region can swallow another's tap.
function ChoreCard({
  chore,
  owner,
  people,
  canAssign,
  frozen,
  onGive,
  onEdit,
  onDragStart,
  symbol,
}: {
  chore: PlanningTasksChore
  owner: string | null
  people: PlanningTasksPerson[]
  canAssign: boolean
  frozen: boolean
  onGive: (personId: string | null) => void
  onEdit?: () => void
  onDragStart: (e: React.PointerEvent) => void
  symbol: (currency: string | null) => string
}) {
  const settable = canAssign && dayIsSettable(chore)
  const unset = chore.days.length === 0 && !chore.dueOn && !chore.carriedOver
  // Unset AND settable reads as an invitation; unset with nothing you can do about it
  // stays a calm statement of fact.
  const chipText = unset && settable ? 'Set a day' : dayChip(chore)
  return (
    <div className="chore wpt-card">
      <div className="body">
        {onEdit ? (
          <button
            type="button"
            className="wpt-open"
            aria-label={`Edit ${chore.title}`}
            title="Edit this task"
            disabled={frozen}
            onClick={onEdit}
          >
            <span className="t">
              {chore.emoji ? `${chore.emoji} ` : ''}
              {chore.title}
            </span>
            <span className="wpt-sub">{provenance(chore)}</span>
          </button>
        ) : (
          <>
            <div className="t">
              {chore.emoji ? `${chore.emoji} ` : ''}
              {chore.title}
            </div>
            <div className="wpt-sub">{provenance(chore)}</div>
          </>
        )}
        <div className="wpt-chip-row">
          {settable && onEdit ? (
            <button
              type="button"
              className={`wpt-chip wpt-chip-set ${unset ? 'is-unset' : ''}`}
              aria-label={`Set the day for ${chore.title}`}
              disabled={frozen}
              onClick={onEdit}
            >
              {chipText}
            </button>
          ) : (
            <span className={`wpt-chip ${unset ? 'is-unset' : ''}`}>{chipText}</span>
          )}
        </div>
        {chore.rewardAmount > 0 && (
          <div className="star">
            {symbol(chore.rewardCurrency)} {chore.rewardAmount}
          </div>
        )}
        {canAssign && (
          <div className="wpt-faces">
            {/* 🙌 is the undo: put it back where anybody can take it. Only on a card
                somebody is holding — the strip is already up for grabs. */}
            {owner !== null && (
              <button
                type="button"
                className="wpt-face wpt-face-grabs"
                title="Put it back up for grabs"
                aria-label={`Put ${chore.title} back up for grabs`}
                disabled={frozen}
                onClick={() => onGive(null)}
              >
                🙌
              </button>
            )}
            {people
              .filter((p) => p.id !== owner)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="wpt-face"
                  style={{ background: avTint(p.colorHex) }}
                  title={`${p.name} takes it`}
                  aria-label={`Give ${chore.title} to ${p.name}`}
                  disabled={frozen}
                  onClick={() => onGive(p.id)}
                >
                  {p.avatarEmoji ?? '🙂'}
                </button>
              ))}
          </div>
        )}
      </div>
      {/* Drag does what the faces do — for the hand that reaches for it instead. */}
      {canAssign && (
        <button
          type="button"
          className="chore-grip"
          aria-label={`Drag ${chore.title} to another column`}
          title="Drag to hand it over"
          onPointerDown={onDragStart}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </button>
      )}
    </div>
  )
}

function Body({ weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const [board, setBoard] = useState<PlanningTasksBoard | null>(null)
  const [error, setError] = useState(false)
  // A hand-over that failed, which is NOT the board failing to load: the board is fine,
  // one write may be half-applied.
  const [giveError, setGiveError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  // `''` is the strip's own "Add a task" (nobody prefilled); null is closed.
  const [adding, setAdding] = useState<string | null>(null)
  // A parked note turned INTO a task: its words seed the title. Null when opened normally.
  const [fromNote, setFromNote] = useState<string | null>(null)

  // "Make a task" opens the very same `ChoreModal` the strip's own "Add a task" opens — the
  // banner grows no composer of its own, so there is one way to add a chore.
  const finishHandoff = useHandoffAction('Make a task', (note) => {
    setFromNote(note)
    setAdding('')
  })
  // A chore's "Who" isn't on the card payload — the column it sits in is that fact.
  const [editing, setEditing] = useState<{ chore: PlanningTasksChore; owner: string | null } | null>(null)
  // The net number handed over this sitting: the only thing worth remembering locally, and
  // a take-back undoes its own tally or the recap would over-report.
  const [assigned, setAssigned] = useState(0)

  const { person } = useHousehold()
  const cur = useCurrencies()
  // Moving a chore between people is chore.manage (the server enforces it), so don't offer
  // a tap that 403s.
  const canAssign = can(person, 'chore.manage')

  const load = useCallback(() => {
    planningTasksApi
      .board(weekStart)
      .then((b) => {
        setBoard(b)
        setError(false)
      })
      .catch(() => setError(true))
  }, [weekStart])
  useEffect(load, [load])

  const open = board?.unassigned.length ?? 0
  useEffect(() => {
    if (!board) return
    setDecisionData({ assigned, leftUpForGrabs: open })
  }, [board, assigned, open, setDecisionData])

  // One path for the face row, the 🙌 and the drop — so a drag can never do something a
  // tap can't undo.
  const give = useCallback(
    async (chore: PlanningTasksChore, personId: string | null) => {
      if (saving || busy) return
      setSaving(chore.id)
      try {
        await planningTasksApi.handOut(chore, personId)
        setGiveError(null)
        setAssigned((n) => (personId ? n + 1 : Math.max(0, n - 1)))
        load()
        refresh()
      } catch {
        // HANDING A CHORE OVER IS TWO WRITES — the definition, then each pending instance —
        // so a failure here does not mean nothing moved. It must not claim otherwise, and
        // must still re-read: we cannot know which half landed, so we ask the server.
        setGiveError('That may not have gone through fully — the board has been re-read, so what you see is what’s saved.')
        load()
        refresh()
      } finally {
        setSaving(null)
      }
    },
    [saving, busy, load, refresh]
  )

  // ── Drag-and-drop, the kiosk Chores board's mechanism ──────────────────────────
  // `drag` is set once per drag so the move/up listeners subscribe only once; `overCol` is
  // read live through a ref inside the up handler. A column's data-colkey is the person
  // id and the strip's is 'unassigned' — the kiosk board's own two-way vocabulary.
  const [drag, setDrag] = useState<{ chore: PlanningTasksChore; from: string | null } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [overCol, setOverCol] = useState<string | null>(null)
  const overColRef = useRef<string | null>(null)
  overColRef.current = overCol
  // The drop lands after this render, so reach the live `give` through a ref rather than
  // re-subscribing the window listeners on every keystroke of state.
  const giveRef = useRef(give)
  giveRef.current = give

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY })
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const col = el && (el as Element).closest('[data-colkey]')
      setOverCol(col ? col.getAttribute('data-colkey') : null)
    }
    const up = () => {
      const target = overColRef.current
      if (target && target !== (drag.from ?? 'unassigned')) {
        giveRef.current(drag.chore, target === 'unassigned' ? null : target)
      }
      setDrag(null)
      setOverCol(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
  }, [drag])

  function startDrag(e: React.PointerEvent, chore: PlanningTasksChore, from: string | null) {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
    setOverCol(null)
    setDrag({ chore, from })
  }

  function savedChore() {
    load()
    refresh()
  }

  if (error) return <div className="wp-empty">Couldn’t load the chores board — try again in a moment.</div>
  if (!board) return <div className="wp-empty">Loading…</div>

  const symbol = (key: string | null) => (key ? cur.byKey[key] : cur.defaultCurrency)?.symbol ?? '⭐'
  const frozen = busy || saving !== null
  const isDropTarget = (colKey: string) => !!drag && overCol === colKey && colKey !== (drag.from ?? 'unassigned')

  const cardProps = (chore: PlanningTasksChore, owner: string | null) => ({
    chore,
    owner,
    people: board.people,
    canAssign,
    frozen,
    onGive: (personId: string | null) => give(chore, personId),
    // chore.manage, the same rule the kiosk board applies: a modal that 403s on Save is
    // worse than no modal. BOTH the title and the day chip open this one editor, so a
    // title change and a day change can't race each other on the same chore.
    onEdit: canAssign ? () => setEditing({ chore, owner }) : undefined,
    onDragStart: (e: React.PointerEvent) => startDrag(e, chore, owner),
    symbol,
  })

  return (
    <div className="wpt">
      {giveError && <div className="wp-err" role="alert">{giveError}</div>}
      {/* The strip: everything nobody has taken, faces underneath. It is also a drop
          target, which is what makes a hand-out reversible by drag as well as by tap. */}
      <div
        className={`wpt-strip ${isDropTarget('unassigned') ? 'is-drop' : ''}`}
        data-testid="wpt-strip"
        data-colkey="unassigned"
      >
        <div className="wpt-strip-h">
          <span className="chore-ava grabs" aria-hidden>🙌</span>
          <span className="wpt-strip-t">Up for grabs</span>
          <span className="wpt-strip-s">
            {board.unassigned.length === 0
              ? '✓ Everything’s handed out.'
              : canAssign
                ? 'Tap a face (or drag the card) to hand one over. Leaving one up for grabs is a real answer — whoever does it gets the stars.'
                : 'Whoever does one gets the stars.'}
          </span>
        </div>
        <div className="wpt-strip-list">
          {board.unassigned.map((c) => (
            <ChoreCard key={c.id} {...cardProps(c, null)} />
          ))}
          {/* The strip's own tile — a task nobody owns yet, which is not the same
              thing as adding one to a person's column. */}
          <button type="button" className="wpt-add-tile" disabled={busy} onClick={() => setAdding('')}>
            <Icon name="plus" />
            Add a task
          </button>
        </div>
      </div>

      {/* The columns — the kiosk Chores layout, one per member, holding what that
          person is carrying for this week. */}
      <div className="wpt-cols">
        {board.people.map((p: PlanningTasksPerson) => (
          <div
            className={`chore-col wpt-col ${isDropTarget(p.id) ? 'drop-target' : ''}`}
            key={p.id}
            data-testid={`wpt-col-${p.name}`}
            data-colkey={p.id}
          >
            <div className="chore-head">
              <span className="nm">
                <span className="chore-ava" style={{ background: avTint(p.colorHex) }}>{p.avatarEmoji ?? '🙂'}</span>
                {p.name}
              </span>
              <span className="wpt-count">{p.chores.length} this week</span>
            </div>

            <div className="chore-list">
              {p.chores.map((c) => (
                <ChoreCard key={c.id} {...cardProps(c, p.id)} />
              ))}
            </div>
            {p.chores.length === 0 && <div className="tiny muted chore-empty">Nothing on {p.name}’s week yet.</div>}

            <button type="button" className="chore-add" disabled={busy} onClick={() => setAdding(p.id)}>
              <Icon name="plus" />
              Add for {p.name}
            </button>

            {/* What they already carry — the fairness read, stated rather than scored. */}
            <div className="wpt-carries">{carriesLabel(p.recurringChores)}</div>
          </div>
        ))}
      </div>

      {/* The app's existing New chore modal, with Who already prefilled — never a
          second chore form of this step's own. '' prefills nobody (up for grabs).
          Planning a week is mostly one-offs, so this surface defaults the modal to Just
          once, dated to the week being planned rather than to whatever day this browser
          thinks it is. The Chores screen keeps its own
          defaults — both of these are props, not a change to the modal. */}
      {adding !== null && (
        <ChoreModal
          personId={adding || null}
          defaultFreq="once"
          defaultDueOn={board.newTaskDay}
          {...(fromNote !== null ? { defaultTitle: fromNote } : {})}
          canAssignOthers={canAssign}
          selfPersonId={person?.id ?? null}
          onClose={() => {
            setAdding(null)
            if (fromNote !== null) { setFromNote(null); finishHandoff(false) }
          }}
          onSaved={() => {
            if (fromNote !== null) { setFromNote(null); finishHandoff(true) }
            savedChore()
          }}
        />
      )}

      {/* The same modal in its OTHER half: editing the chore this card stands for, so a
          typo or "actually this repeats weekly" is fixed here instead of sending someone to
          the Chores screen mid-session. The day IS in it, and the chip beside the title is
          the second door into this same modal. DELETE IS OFF (canDelete={false}): the step
          asks who does what, not which chores should exist, and the Meals step's shopping
          trip is a real chore on this board whose id other steps resolve. "Up for grabs" is
          the answer to "not this person", and the Chores screen still deletes. */}
      {editing && (
        <ChoreModal
          chore={{
            id: editing.chore.id,
            title: editing.chore.title,
            emoji: editing.chore.emoji,
            personId: editing.owner,
            rewardAmount: editing.chore.rewardAmount,
            rewardCurrency: editing.chore.rewardCurrency,
            rrule: editing.chore.rrule,
            // The day the editor opens on, so tapping the chip lands on the day the card was
            // showing. Omitting it would silently move the chore to today.
            dueOn: editing.chore.dueOn,
            dueTime: editing.chore.dueTime,
            requiresApproval: editing.chore.requiresApproval,
            requiresPhoto: editing.chore.requiresPhoto,
          }}
          canAssignOthers={canAssign}
          canDelete={false}
          selfPersonId={person?.id ?? null}
          onClose={() => setEditing(null)}
          onSaved={savedChore}
        />
      )}

      {drag && (
        <div className="chore-drag-ghost" style={{ left: pos.x, top: pos.y }}>
          {drag.chore.emoji ? `${drag.chore.emoji} ` : ''}
          {drag.chore.title}
        </div>
      )}
    </div>
  )
}

const mod: PlanningStepModule = { Body }
export default mod
