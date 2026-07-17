import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { usePersons, useHousehold, api, countdownsApi, pantryApi, can, localToday, emit, emitHouseholdChanged, type Topic, type Person, type ListSummary, type Candidate } from '../../lib/api'
import { parseCapture, intentSummary, looksConfident, memberTypeLabel, MEMBER_TYPES, goalTypeLabel, GOAL_TYPES, mutateTargetLabel, type ParsedIntent } from '../../lib/capture/parse'
import { moduleEnabled, rewardsEnabled } from '../../lib/modules'
import { describeRrule } from './recurrence'

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const freqOf = (r: string | null): string =>
  !r ? '' : /FREQ=DAILY/.test(r) ? 'daily' : /FREQ=WEEKLY/.test(r) ? 'weekly' : /FREQ=MONTHLY/.test(r) ? 'monthly' : /FREQ=YEARLY/.test(r) ? 'yearly' : 'custom'

// The "Add anything…" capture bar (roadmap 6.6). A compact trigger in the topbar
// opens a centered floating composer. It shows an instant on-device parse and
// upgrades to the configured LLM, commits exactly what the preview shows on ↵, and
// lets you edit the parsed result inline (fix text, re-route the type, set the
// basics — who/which list/when).
const VIA_LABEL: Record<string, string> = {
  'on-device': 'on-device',
  anthropic: 'Claude',
  openai: 'OpenAI',
  ollama: 'local LLM',
}
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']
const KINDS: Array<{ k: ParsedIntent['kind']; label: string }> = [
  { k: 'event', label: '📅 Event' },
  { k: 'list', label: '📝 List' },
  { k: 'grocery', label: '🛒 Grocery' },
  { k: 'task', label: '✅ Task' },
  { k: 'meal', label: '🍽️ Meal' },
  { k: 'countdown', label: '⏳ Countdown' },
  { k: 'person', label: '👤 Family member' },
  { k: 'goal', label: '🎯 Goal' },
  { k: 'pantry', label: '🥫 Pantry' },
  { k: 'reward', label: '🎁 Reward' },
]

const kindLabel = (k: ParsedIntent['kind']) => KINDS.find((x) => x.k === k)?.label ?? 'item'
const pad = (n: number) => String(n).padStart(2, '0')
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}
function eventWhen(date: string, time: string | null, allDay: boolean): string {
  const d = new Date(`${date}T${allDay ? '12:00' : time || '12:00'}:00`)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return allDay ? `${day} · All day` : `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}
function mealWhen(date: string, mealType: string): string {
  const d = new Date(`${date}T12:00:00`)
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${cap(mealType)}`
}
function countdownWhen(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86_400_000)
  const rel = days <= 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`
  return `${dayLabel} · ${rel}`
}

function primaryOf(i: ParsedIntent): string {
  switch (i.kind) {
    case 'event':
    case 'task':
    case 'meal':
    case 'countdown':
    case 'goal':
    case 'reward':
      return i.title
    case 'grocery':
      return i.name
    case 'person':
      return i.name
    case 'pantry':
      return i.name
    case 'list':
      return i.itemName
    case 'mutate':
      return i.target.description
    case 'unsupported':
      return ''
  }
}
function withPrimary(i: ParsedIntent, v: string): ParsedIntent {
  switch (i.kind) {
    case 'event':
    case 'task':
    case 'meal':
    case 'countdown':
    case 'goal':
    case 'reward':
      return { ...i, title: v }
    case 'grocery':
      return { ...i, name: v }
    case 'person':
      return { ...i, name: v }
    case 'pantry':
      return { ...i, name: v }
    case 'list':
      return { ...i, itemName: v }
    case 'mutate':
      // A mutate isn't edited inline (its "primary" is a resolved row, not free text).
      return i
    case 'unsupported':
      return i
  }
}
function rerouteKind(i: ParsedIntent, kind: ParsedIntent['kind'], today: string): ParsedIntent {
  const primary = primaryOf(i) || 'Item'
  const personName = i.kind === 'event' || i.kind === 'task' ? i.personName : null
  const quantity = i.kind === 'grocery' || i.kind === 'list' ? i.quantity : null
  switch (kind) {
    case 'event': {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return { kind: 'event', title: primary, startsAt: d.toISOString(), allDay: true, personName, rrule: null, recurrenceEndAt: null, scheduleLabel: '', whenLabel: eventWhen(localToday(), null, true) }
    }
    case 'task':
      return { kind: 'task', title: primary, personName, stars: null, rrule: null, scheduleLabel: '' }
    case 'grocery':
      return { kind: 'grocery', name: primary, quantity }
    case 'list':
      return { kind: 'list', itemName: primary, listName: i.kind === 'list' ? i.listName : null, quantity }
    case 'meal':
      return { kind: 'meal', title: primary, date: today, mealType: 'dinner', whenLabel: mealWhen(today, 'dinner') }
    case 'countdown':
      return { kind: 'countdown', title: primary, date: today, emoji: i.kind === 'countdown' ? i.emoji : null, whenLabel: countdownWhen(today) }
    case 'person':
      return {
        kind: 'person',
        name: primary,
        memberType: i.kind === 'person' ? i.memberType : 'adult',
        avatarEmoji: i.kind === 'person' ? i.avatarEmoji : null,
        birthday: i.kind === 'person' ? i.birthday : null,
        isAdmin: i.kind === 'person' ? i.isAdmin : false,
      }
    case 'goal':
      return {
        kind: 'goal',
        title: primary,
        goalType: i.kind === 'goal' ? i.goalType : 'habit',
        targetValue: i.kind === 'goal' ? i.targetValue : null,
        unit: i.kind === 'goal' ? i.unit : null,
        deadline: i.kind === 'goal' ? i.deadline : null,
        trackingMode: i.kind === 'goal' ? i.trackingMode : 'shared_total',
        participantMode: i.kind === 'goal' ? i.participantMode : 'count_once',
        targetBasis: i.kind === 'goal' ? i.targetBasis : 'family',
        participantIds: i.kind === 'goal' ? i.participantIds : [],
        audience: i.kind === 'goal' ? i.audience : null,
      }
    case 'pantry':
      return {
        kind: 'pantry',
        name: primary,
        amount: i.kind === 'pantry' ? i.amount : quantity,
        unit: i.kind === 'pantry' ? i.unit : null,
        location: i.kind === 'pantry' ? i.location : 'Pantry',
        expiresOn: i.kind === 'pantry' ? i.expiresOn : null,
        lowAt: i.kind === 'pantry' ? i.lowAt : null,
      }
    case 'reward':
      return {
        kind: 'reward',
        title: primary,
        emoji: i.kind === 'reward' ? i.emoji : null,
        // Re-routing a chore's stars → the reward's cost is a natural carry-over.
        cost: i.kind === 'reward' ? i.cost : i.kind === 'task' ? i.stars : null,
        currency: i.kind === 'reward' ? i.currency : null,
        category: i.kind === 'reward' ? i.category : null,
        requiresApproval: i.kind === 'reward' ? i.requiresApproval : null,
      }
    default:
      return i
  }
}

// Compact person picker (chips). `allowNone` shows an "Up for grabs" / "Anyone" option.
function PersonChips({ persons, value, onChange, noneLabel }: { persons: Person[]; value: string | null; onChange: (name: string | null) => void; noneLabel: string }) {
  return (
    <div className="cap-people">
      <button type="button" className={`cap-person ${!value ? 'on' : ''}`} onClick={() => onChange(null)}>{noneLabel}</button>
      {persons.map((p) => {
        const on = value?.toLowerCase() === p.name.toLowerCase()
        const color = p.colorHex ?? '#6B6B70'
        return (
          <button key={p.id} type="button" className={`cap-person ${on ? 'on' : ''}`} style={on ? { borderColor: color, color, background: `${color}18` } : undefined} onClick={() => onChange(p.name)}>
            {p.avatarEmoji ?? '🙂'} {p.name}
          </button>
        )
      })}
    </div>
  )
}

// Seed the "who's it for" SET from the inferred audience: 'everyone' → all members;
// 'me'/null → just the viewer (empty when the viewer id hasn't loaded yet, so the preview
// still renders). Pure so it's unit-testable.
export function seedGoalParticipants(audience: 'me' | 'everyone' | null, viewerId: string | null, allIds: string[], canManageOthers = true): string[] {
  // A non-manager (a kid) can only create a self-only goal — POST /api/goals requires the
  // goal.manage capability the moment participants include anyone but the caller — so we
  // clamp "everyone" down to just the viewer rather than 403 on commit.
  if (!canManageOthers) return viewerId ? [viewerId] : []
  if (audience === 'everyone' && allIds.length) return allIds
  return viewerId ? [viewerId] : []
}

// Which preset chip is lit, derived from the participant SET (not a separate mode flag):
// "Just me" ⇔ the set is exactly {viewer}; "Everyone" ⇔ the set is every member. Pure so
// it's unit-testable and shared with GoalWho.
export function goalWhoHighlights(ids: string[], viewerId: string | null, allIds: string[]): { isJustMe: boolean; isEveryone: boolean } {
  const isEveryone = allIds.length > 0 && ids.length === allIds.length && allIds.every((id) => ids.includes(id))
  const isJustMe = !!viewerId && ids.length === 1 && ids[0] === viewerId
  return { isJustMe, isEveryone }
}

// "Who's it for?" for a goal — mirrors GoalCreate's assignment payload but keeps the
// quick-add control simple: Just me (personal), Everyone (shared across the household), or
// a hand-picked subset. All three send trackingMode 'shared_total' / participantMode
// 'count_once' / targetBasis 'family' (set on the intent); only participantIds vary.
//
// The selection is modeled as a SET of participantIds: "Just me" = {viewer}, "Everyone" =
// all member ids, and each person tile toggles membership. The set drives EVERY highlight —
// so clicking "Just me" also lights the viewer's own tile (they're the same person) and
// clicking only your own tile is equivalent to Just me. The set is seeded once from the
// inferred `audience` so "family"/"personal" phrasing lands on the right preset.
// Reuses the .cap-people person chips.
function GoalWho({ intent, persons, viewer, set, canManageGoals }: { intent: Extract<ParsedIntent, { kind: 'goal' }>; persons: Person[]; viewer: Person | null; set: (i: ParsedIntent) => void; canManageGoals: boolean }) {
  const ids = intent.participantIds
  const allIds = useMemo(() => persons.map((p) => p.id), [persons])
  // Seed the set from the inferred audience while it's still empty (nothing picked yet).
  useEffect(() => {
    if (ids.length === 0) {
      const seed = seedGoalParticipants(intent.audience, viewer?.id ?? null, allIds, canManageGoals)
      if (seed.length) set({ ...intent, participantIds: seed })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.audience, viewer?.id, allIds.length, canManageGoals])
  // A non-manager (a kid) can only make a personal goal, so there's no picker to show —
  // just a lit, non-interactive "Assigned to you" chip (reusing the .cap-people chips).
  if (!canManageGoals) {
    return (
      <div className="cap-people">
        <span className="cap-person on">🙋 Assigned to you</span>
      </div>
    )
  }
  const { isJustMe, isEveryone } = goalWhoHighlights(ids, viewer?.id ?? null, allIds)
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    set({ ...intent, participantIds: next })
  }
  return (
    <div className="cap-people">
      <button type="button" className={`cap-person ${isJustMe ? 'on' : ''}`} onClick={() => set({ ...intent, participantIds: viewer ? [viewer.id] : [] })}>🙋 Just me</button>
      <button type="button" className={`cap-person ${isEveryone ? 'on' : ''}`} onClick={() => set({ ...intent, participantIds: allIds })}>👨‍👩‍👧 Everyone</button>
      {persons.map((p) => {
        const on = ids.includes(p.id)
        const color = p.colorHex ?? '#6B6B70'
        return (
          <button key={p.id} type="button" className={`cap-person ${on ? 'on' : ''}`} style={on ? { borderColor: color, color, background: `${color}18` } : undefined} onClick={() => toggle(p.id)}>
            {p.avatarEmoji ?? '🙂'} {p.name}
          </button>
        )
      })}
    </div>
  )
}

// Per-kind "basics" — extends the inline edit beyond just the title.
function DraftFields({ intent, persons, lists, set, today, viewer, canManageGoals }: { intent: ParsedIntent; persons: Person[]; lists: ListSummary[]; set: (i: ParsedIntent) => void; today: string; viewer: Person | null; canManageGoals: boolean }) {
  if (intent.kind === 'grocery') {
    return (
      <input className="cap-edit-sub" value={intent.quantity ?? ''} placeholder="quantity (optional, e.g. 2 lbs)" aria-label="Quantity" onChange={(e) => set({ ...intent, quantity: e.target.value || null })} />
    )
  }
  if (intent.kind === 'list') {
    const known = lists.some((l) => l.name === intent.listName)
    return (
      <>
        <select className="cap-edit-sub" value={known ? intent.listName ?? '' : '__new__'} aria-label="List" onChange={(e) => set({ ...intent, listName: e.target.value === '__new__' ? '' : e.target.value })}>
          {lists.map((l) => <option key={l.id} value={l.name}>{(l.emoji ? `${l.emoji} ` : '') + l.name}</option>)}
          <option value="__new__">＋ New list…</option>
        </select>
        {!known && (
          <input className="cap-edit-sub" value={intent.listName ?? ''} placeholder="new list name" aria-label="New list name" onChange={(e) => set({ ...intent, listName: e.target.value || null })} />
        )}
      </>
    )
  }
  if (intent.kind === 'task') {
    return (
      <>
        <PersonChips persons={persons} value={intent.personName} onChange={(name) => set({ ...intent, personName: name })} noneLabel="🙌 Up for grabs" />
        <label className="cap-stars">Stars <input type="number" min={0} value={intent.stars ?? 0} onChange={(e) => set({ ...intent, stars: Number(e.target.value) || null })} /></label>
      </>
    )
  }
  if (intent.kind === 'event') {
    const { date, time } = localParts(intent.startsAt)
    const upd = (d: string, t: string | null, allDay: boolean) => {
      const startsAt = new Date(`${d}T${allDay ? '12:00' : t || '12:00'}:00`).toISOString()
      set({ ...intent, startsAt, allDay, whenLabel: eventWhen(d, t, allDay) })
    }
    const freq = freqOf(intent.rrule)
    const setFreq = (v: string) => {
      const start = new Date(intent.startsAt)
      const rrule =
        v === 'daily' ? 'FREQ=DAILY'
        : v === 'weekly' ? `FREQ=WEEKLY;BYDAY=${BYDAY[start.getDay()]}`
        : v === 'monthly' ? 'FREQ=MONTHLY'
        : v === 'yearly' ? 'FREQ=YEARLY'
        : null
      // Clearing the repeat clears any end date too.
      set({ ...intent, rrule, recurrenceEndAt: rrule ? intent.recurrenceEndAt ?? null : null, scheduleLabel: rrule ? describeRrule(rrule, start) : '' })
    }
    const untilDate = intent.recurrenceEndAt ? localParts(intent.recurrenceEndAt).date : ''
    return (
      <>
        <PersonChips persons={persons} value={intent.personName} onChange={(name) => set({ ...intent, personName: name })} noneLabel="Nobody" />
        <div className="cap-edit-row">
          <input type="date" className="cap-edit-mini" value={date} onChange={(e) => upd(e.target.value, time, intent.allDay)} aria-label="Date" />
          {!intent.allDay && <input type="time" className="cap-edit-mini" value={time} onChange={(e) => upd(date, e.target.value, false)} aria-label="Time" />}
          <button type="button" className={`cap-person ${intent.allDay ? 'on' : ''}`} onClick={() => upd(date, time, !intent.allDay)}>All day</button>
        </div>
        <div className="cap-edit-row">
          <label className="cap-stars" style={{ gap: 6 }}>Repeats
            <select className="cap-edit-mini" style={{ cursor: 'pointer' }} value={freq === 'custom' ? 'custom' : freq} onChange={(e) => setFreq(e.target.value)} aria-label="Repeats">
              <option value="">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              {freq === 'custom' && <option value="custom">Custom ({intent.scheduleLabel})</option>}
            </select>
          </label>
          {intent.rrule && (
            <label className="cap-stars" style={{ gap: 6 }}>Until
              <input
                type="date"
                className="cap-edit-mini"
                value={untilDate}
                onChange={(e) => set({ ...intent, recurrenceEndAt: e.target.value ? new Date(`${e.target.value}T23:59:00`).toISOString() : null })}
                aria-label="Until"
              />
            </label>
          )}
        </div>
      </>
    )
  }
  if (intent.kind === 'meal') {
    return (
      <div className="cap-edit-row">
        <div className="cap-people">
          {MEAL_TYPES.map((mt) => (
            <button key={mt} type="button" className={`cap-person ${intent.mealType === mt ? 'on' : ''}`} onClick={() => set({ ...intent, mealType: mt, whenLabel: mealWhen(intent.date ?? today, mt) })}>{cap(mt)}</button>
          ))}
        </div>
        <input type="date" className="cap-edit-mini" value={intent.date ?? today} onChange={(e) => set({ ...intent, date: e.target.value, whenLabel: mealWhen(e.target.value, intent.mealType) })} aria-label="Date" />
      </div>
    )
  }
  if (intent.kind === 'countdown') {
    return (
      <div className="cap-edit-row">
        <input type="date" className="cap-edit-mini" value={intent.date} onChange={(e) => set({ ...intent, date: e.target.value, whenLabel: countdownWhen(e.target.value) })} aria-label="Date" />
      </div>
    )
  }
  if (intent.kind === 'person') {
    return (
      <>
        <div className="cap-people">
          {MEMBER_TYPES.map((mt) => (
            <button key={mt} type="button" className={`cap-person ${intent.memberType === mt ? 'on' : ''}`} onClick={() => set({ ...intent, memberType: mt })}>{memberTypeLabel(mt)}</button>
          ))}
        </div>
        <div className="cap-edit-row">
          <input className="cap-edit-mini" value={intent.avatarEmoji ?? ''} placeholder="emoji" aria-label="Avatar emoji" style={{ maxWidth: 72 }} onChange={(e) => set({ ...intent, avatarEmoji: e.target.value || null })} />
          <input type="date" className="cap-edit-mini" value={intent.birthday ?? ''} aria-label="Birthday" onChange={(e) => set({ ...intent, birthday: e.target.value || null })} />
        </div>
      </>
    )
  }
  if (intent.kind === 'goal') {
    // Count/total carry a numeric target + unit; habit/checklist don't. Clearing the
    // target when switching to a habit keeps the commit body honest.
    const measured = intent.goalType === 'count' || intent.goalType === 'total'
    return (
      <>
        <div className="cap-people">
          {GOAL_TYPES.map((gt) => (
            <button key={gt} type="button" className={`cap-person ${intent.goalType === gt ? 'on' : ''}`} onClick={() => set({ ...intent, goalType: gt, ...(gt === 'count' || gt === 'total' ? {} : { targetValue: null, unit: null }) })}>{goalTypeLabel(gt)}</button>
          ))}
        </div>
        {measured && (
          <div className="cap-edit-row">
            <input type="number" min={0} className="cap-edit-mini" value={intent.targetValue ?? ''} placeholder="target" aria-label="Target" style={{ maxWidth: 96 }} onChange={(e) => set({ ...intent, targetValue: e.target.value === '' ? null : Number(e.target.value) })} />
            <input className="cap-edit-mini" value={intent.unit ?? ''} placeholder="unit (e.g. books)" aria-label="Unit" onChange={(e) => set({ ...intent, unit: e.target.value || null })} />
          </div>
        )}
        <div className="cap-edit-row">
          <label className="cap-stars" style={{ gap: 6 }}>By
            <input type="date" className="cap-edit-mini" value={intent.deadline ?? ''} aria-label="Deadline" onChange={(e) => set({ ...intent, deadline: e.target.value || null })} />
          </label>
        </div>
        <GoalWho intent={intent} persons={persons} viewer={viewer} set={set} canManageGoals={canManageGoals} />
      </>
    )
  }
  if (intent.kind === 'pantry') {
    // Keep the current location selectable even if it's a household-custom one.
    const locations = Array.from(new Set(['Pantry', 'Fridge', 'Freezer', intent.location]))
    return (
      <>
        <div className="cap-edit-row">
          <input className="cap-edit-mini" value={intent.amount ?? ''} placeholder="amount" aria-label="Amount" style={{ maxWidth: 96 }} onChange={(e) => set({ ...intent, amount: e.target.value || null })} />
          <input className="cap-edit-mini" value={intent.unit ?? ''} placeholder="unit (e.g. cans)" aria-label="Unit" onChange={(e) => set({ ...intent, unit: e.target.value || null })} />
        </div>
        <div className="cap-people">
          {locations.map((loc) => (
            <button key={loc} type="button" className={`cap-person ${intent.location === loc ? 'on' : ''}`} onClick={() => set({ ...intent, location: loc })}>{loc}</button>
          ))}
        </div>
        <div className="cap-edit-row">
          <label className="cap-stars" style={{ gap: 6 }}>Expires
            <input type="date" className="cap-edit-mini" value={intent.expiresOn ?? ''} aria-label="Expires on" onChange={(e) => set({ ...intent, expiresOn: e.target.value || null })} />
          </label>
          <label className="cap-stars" style={{ gap: 6 }}>Low at
            <input type="number" min={0} className="cap-edit-mini" style={{ maxWidth: 72 }} value={intent.lowAt ?? ''} aria-label="Low at" onChange={(e) => set({ ...intent, lowAt: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
        </div>
      </>
    )
  }
  if (intent.kind === 'reward') {
    return (
      <>
        <div className="cap-edit-row">
          <input className="cap-edit-mini" value={intent.emoji ?? ''} placeholder="emoji" aria-label="Emoji" style={{ maxWidth: 72 }} onChange={(e) => set({ ...intent, emoji: e.target.value || null })} />
          {/* Reuse the star-cost control (same as a task's Stars) for the reward price. */}
          <label className="cap-stars">Cost <input type="number" min={0} value={intent.cost ?? 0} aria-label="Cost" onChange={(e) => set({ ...intent, cost: e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))) })} /></label>
        </div>
        <div className="cap-people">
          <button type="button" className={`cap-person ${intent.requiresApproval ? 'on' : ''}`} onClick={() => set({ ...intent, requiresApproval: intent.requiresApproval === true ? false : true })}>Needs approval</button>
        </div>
      </>
    )
  }
  return null
}

// TIER 2 — the mutate flow's candidate picker. Reuses the .cap-people/.cap-person chips
// (same as PersonChips/GoalWho). 0 candidates → a not-found line (+ any disabledReason);
// 1 → auto-selected, still confirmed explicitly; 2+ → chips to pick. Every `delete` (even
// a single confident match) demands the explicit destructive button — ↵ never deletes.
const CONFIRM_LABEL: Record<string, string> = {
  complete: 'Mark done', log: 'Log it', reschedule: 'Reschedule', reassign: 'Reassign', redeem: 'Redeem', delete: 'Delete it',
}
type CandidateState = { list: Candidate[]; disabledReason?: string; unsupported?: boolean; forDesc: string; offline?: boolean }
function CandidatePicker({ intent, state, chosenId, onPick, onCommit, busy }: {
  intent: Extract<ParsedIntent, { kind: 'mutate' }>
  state: CandidateState | null
  chosenId: string | null
  onPick: (id: string) => void
  onCommit: () => void
  busy: boolean
}) {
  const kindLabel = mutateTargetLabel(intent.targetKind)
  // Still resolving (no result yet, or a stale result for a previous phrase).
  if (!state || state.forDesc !== intent.target.description) {
    return <div className="cap-detail">Finding a {kindLabel} like that…</div>
  }
  if (state.offline) {
    return <div className="cap-primary" style={{ whiteSpace: 'normal' }}>I need a connection for that.</div>
  }
  if (state.list.length === 0) {
    // `unsupported` = quick-add can't act on this kind/verb yet (the row may well exist) —
    // show ONLY the server's reason, never a misleading "couldn't find it".
    if (state.unsupported) {
      return <div className="cap-primary" style={{ whiteSpace: 'normal' }}>{state.disabledReason ?? 'Quick-add can’t do that yet.'}</div>
    }
    return (
      <div className="cap-primary" style={{ whiteSpace: 'normal' }}>
        Couldn’t find a {kindLabel} like that{state.disabledReason ? ` — ${state.disabledReason}` : ''}
      </div>
    )
  }
  const isDelete = intent.verb === 'delete'
  return (
    <>
      <div className="cap-people">
        {state.list.map((c) => (
          <button key={c.id} type="button" className={`cap-person ${chosenId === c.id ? 'on' : ''}`} onClick={() => onPick(c.id)}>
            {c.title}{c.subtitle ? ` · ${c.subtitle}` : ''}
          </button>
        ))}
      </div>
      {chosenId && (
        <button type="button" className={`btn btn-primary ${isDelete ? 'cap-danger' : ''}`} style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={onCommit}>
          {CONFIRM_LABEL[intent.verb] ?? 'Confirm'}
        </button>
      )}
    </>
  )
}

export function CaptureBar() {
  const { persons } = usePersons()
  // The current viewer's admin state gates the `person` (add-a-member) commit —
  // creating a household member is an adminRoute, so non-admins get a graceful
  // "unsupported" preview instead of a 403 on POST. The household drives the `goal`
  // module gate (Goals is default-on but a household can turn it off).
  const { person: viewer, household } = useHousehold()
  const isAdmin = !!viewer?.isAdmin
  const goalsOn = moduleEnabled(household, 'goals')
  // Pantry defaults OFF, so its intent is SUPPRESSED unless the module is enabled —
  // a parse that yields `pantry` degrades to an "unsupported" preview before any POST.
  const pantryOn = moduleEnabled(household, 'pantry')
  // Reward has TWO gates that must BOTH hold to offer the commit: rewards must be on
  // (chores module + the settings.chores.rewards sub-toggle) AND the viewer must hold
  // the `reward.manage` capability (kids don't). Either failing → an unsupported preview.
  const rewardsOn = rewardsEnabled(household)
  const canManageRewards = can(viewer, 'reward.manage')
  // POST /api/goals requires goal.manage the moment a goal includes anyone but the caller
  // (kids lack it). We don't block a kid — they CAN make a personal goal — so this only
  // clamps the "who's it for" set/picker down to themselves.
  const canManageGoals = can(viewer, 'goal.manage')
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  const [server, setServer] = useState<{ intent: ParsedIntent | null; via: string; forText: string } | null>(null)
  const [lists, setLists] = useState<ListSummary[]>([])
  const [draft, setDraft] = useState<ParsedIntent | null>(null)
  // TIER 2 — the candidate rows for a mutate intent (from /api/capture/resolve) and the
  // chosen one's id. `state.forDesc` guards against showing candidates for a stale phrase.
  const [candidates, setCandidates] = useState<CandidateState | null>(null)
  const [chosenId, setChosenId] = useState<string | null>(null)
  // When the LLM disagrees with a confident on-device guess on the *kind*, we keep
  // the on-device preview and offer the LLM's take — this flips to it on demand.
  const [preferLlm, setPreferLlm] = useState(false)
  const seq = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const names = useMemo(() => persons.map((p) => p.name), [persons])
  const customLists = useMemo(() => lists.filter((l) => l.listType !== 'grocery'), [lists])
  const listNames = useMemo(() => customLists.map((l) => l.name), [customLists])
  const localIntent = useMemo<ParsedIntent | null>(() => parseCapture(text, names, new Date(), listNames), [text, names, listNames])

  useEffect(() => {
    let alive = true
    api.lists().then((d) => alive && setLists(d.lists)).catch(() => {})
    return () => { alive = false }
  }, [])

  // Debounced server resolve. ~0.8s after you stop typing, so we capture whole
  // phrases instead of hammering the model on every keystroke/space.
  useEffect(() => {
    if (!text.trim()) {
      setServer(null)
      setThinking(false)
      return
    }
    const mine = ++seq.current
    setThinking(true)
    const id = setTimeout(async () => {
      const r = await api.resolve(text, names, listNames)
      if (mine === seq.current) {
        // Be defensive: a server goal intent may arrive without participantIds/audience —
        // normalize so the goal preview + picker never read an undefined array.
        const intent =
          r.intent?.kind === 'goal'
            ? { ...r.intent, participantIds: r.intent.participantIds ?? [], audience: r.intent.audience ?? null }
            : r.intent
        setServer({ intent, via: r.via, forText: text })
        setThinking(false)
      }
    }, 800)
    return () => clearTimeout(id)
  }, [text, names, listNames])

  useEffect(() => { setDraft(null); setPreferLlm(false) }, [text])

  useEffect(() => {
    const el = taRef.current
    if (!el || !expanded) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, expanded])

  const usingServer = server && server.forText === text
  const serverIntent = usingServer ? server!.intent : null
  // The model "upgrade" can be a downgrade — especially a small local model that
  // flips a clear calendar event into a task. When it disagrees on *kind* with a
  // CONFIDENT on-device guess, keep ours and offer theirs (one tap), rather than
  // silently swapping. Agreement (or a weak local fallback) still defers to the model.
  const disagrees = !!serverIntent && !!localIntent && looksConfident(localIntent, text) && serverIntent.kind !== localIntent.kind
  const showingServer = usingServer && !(disagrees && !preferLlm)
  const parsed = showingServer ? serverIntent : localIntent
  const altIntent = disagrees ? (preferLlm ? localIntent : serverIntent) : null
  const altFrom = preferLlm ? 'on-device guess' : `${VIA_LABEL[server?.via ?? ''] ?? 'the LLM'}`
  const via = showingServer ? server!.via : 'on-device'
  // While the model is still thinking and the on-device guess is just a weak
  // grocery fallback, don't assert it — show a thinking row instead.
  const thinkingPlaceholder = !usingServer && thinking && !looksConfident(localIntent, text)
  const rawIntent = draft ?? (thinkingPlaceholder ? null : parsed)
  // Gates: only admins can add a household member (adminRoute); goals can be created
  // only when the Goals module is on; and pantry (default OFF) is suppressed entirely
  // unless the Pantry module is on. Each blocked case degrades gracefully to an
  // unsupported preview (with a reason) rather than POSTing and eating a 4xx.
  const intent: ParsedIntent | null =
    rawIntent?.kind === 'person' && !isAdmin
      ? { kind: 'unsupported', reason: 'Only an adult can add family members.' }
      : rawIntent?.kind === 'goal' && !goalsOn
        ? { kind: 'unsupported', reason: 'Goals is turned off. Turn it on in Settings → Modules to add goals.' }
        : rawIntent?.kind === 'pantry' && !pantryOn
          ? { kind: 'unsupported', reason: 'The Pantry module is turned off. Turn it on in Settings → Modules to add pantry items.' }
          : rawIntent?.kind === 'reward' && (!rewardsOn || !canManageRewards)
            ? { kind: 'unsupported', reason: !rewardsOn ? 'Rewards are turned off.' : 'Ask a parent to add a reward.' }
            // A mutate always goes to the SERVER's candidate lookup (POST /capture/resolve) — even
            // when the *parse* came from the on-device heuristic (a household with no LLM configured
            // still resolves + commits online). We only surface "I need a connection" when the
            // resolve call itself fails (handled below), NOT merely because the parse was on-device.
            : rawIntent
  const editing = draft !== null && intent?.kind !== 'unsupported' && intent?.kind !== 'mutate'
  // A stable key for the current mutate intent — drives the candidate resolve so it fires
  // once per distinct phrase (not on every render). ONLY a SETTLED parse gets a key: one
  // api.resolve returned for the CURRENT text (`usingServer` — including via 'on-device',
  // the no-LLM fallback inside api.resolve). The per-keystroke LOCAL parse must never fire
  // /capture/resolve — paste/dictation/resumed typing briefly renders with thinking=false,
  // and each stray call with a partial description costs a server round-trip that also
  // inserts today's chore instances (ensureTodayInstances).
  const mutateKey = intent?.kind === 'mutate' && usingServer ? `${intent.verb}|${intent.targetKind}|${intent.target.description}` : null

  // Resolve candidates once a settled mutate intent arrives (keyed on mutateKey so it
  // fires per distinct phrase, not per render). Clears the picker for any non-mutate
  // (or a not-yet-settled parse).
  useEffect(() => {
    if (!mutateKey || intent?.kind !== 'mutate') { setCandidates(null); setChosenId(null); return }
    const desc = intent.target.description
    let alive = true
    setCandidates(null)
    setChosenId(null)
    api.resolveCandidates({ verb: intent.verb, targetKind: intent.targetKind, target: intent.target, args: intent.args })
      .then((r) => {
        if (!alive) return
        setCandidates({ list: r.candidates, disabledReason: r.disabledReason, unsupported: r.unsupported, forDesc: desc })
        // 1 candidate → auto-select (still confirmed explicitly); 2+ → leave unpicked.
        setChosenId(r.candidates.length === 1 ? r.candidates[0].id : null)
      })
      .catch(() => { if (alive) setCandidates({ list: [], forDesc: desc, offline: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateKey])

  function open() {
    setExpanded(true)
    setFlash(null)
    void api.warm()
    setTimeout(() => taRef.current?.focus(), 0)
  }
  function close() {
    setExpanded(false)
    setText('')
    setServer(null)
    setDraft(null)
    setCandidates(null)
    setChosenId(null)
    setThinking(false)
    setFlash(null)
  }

  function personId(name: string | null): string | null {
    if (!name) return null
    return persons.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null
  }

  async function commit(i: ParsedIntent): Promise<string> {
    if (i.kind === 'event') {
      await api.createEvent({ title: i.title, startsAt: i.startsAt, allDay: i.allDay, personId: personId(i.personName), rrule: i.rrule ?? undefined, recurrenceEndAt: i.recurrenceEndAt ?? undefined })
      return `Added “${i.title}”${i.rrule ? ' (repeating)' : ''} to the calendar`
    }
    if (i.kind === 'grocery') {
      const label = i.quantity ? `${i.name} (${i.quantity})` : i.name
      await api.addGroceryItem(label)
      return `Added “${i.name}” to the grocery list`
    }
    if (i.kind === 'list') {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
      const named = (await api.lists()).lists.filter((l) => l.listType !== 'grocery')
      let target = i.listName
        ? named.find((l) => norm(l.name) === norm(i.listName!)) ??
          named.find((l) => norm(l.name).includes(norm(i.listName!)) || norm(i.listName!).includes(norm(l.name)))
        : undefined
      if (!target) target = await api.createList({ name: i.listName?.trim() || 'List' })
      await api.addListItem(target.id, { name: i.itemName, quantity: i.quantity ?? undefined })
      return `Added “${i.itemName}” to ${target.name}`
    }
    if (i.kind === 'meal') {
      const date = i.date ?? localToday()
      let recipeId: string | undefined
      try {
        const { recipes } = await api.recipes()
        const n = i.title.toLowerCase()
        const hit = recipes.find((r) => (r.title ?? '').toLowerCase() === n) ?? recipes.find((r) => (r.title ?? '').toLowerCase().includes(n))
        recipeId = hit?.id
      } catch {
        /* recipe lookup is best-effort */
      }
      await api.planSlot({ date, mealType: i.mealType, recipeId, title: recipeId ? undefined : i.title })
      return `Added “${i.title}” to ${i.mealType} (${i.whenLabel.split(' · ')[0]})`
    }
    if (i.kind === 'countdown') {
      await countdownsApi.create({ title: i.title, date: i.date, emoji: i.emoji ?? undefined })
      return `Added the “${i.title}” countdown`
    }
    if (i.kind === 'person') {
      await api.createPerson({
        name: i.name,
        memberType: i.memberType,
        avatarEmoji: i.avatarEmoji ?? undefined,
        birthday: i.birthday ?? undefined,
        isAdmin: i.isAdmin,
      })
      return `Added ${i.name} to the family`
    }
    if (i.kind === 'goal') {
      // An empty list means the picker was never touched — resolve it here from the
      // inferred audience so a "family goal" committed straight from the glance still
      // assigns everyone, while anything else falls back to the current viewer (assigning
      // only yourself never needs goal.manage). A picked subset / Everyone is sent as-is.
      const participantIds = i.participantIds.length
        ? i.participantIds
        : seedGoalParticipants(i.audience, viewer?.id ?? null, persons.map((p) => p.id), canManageGoals)
      // Final clamp: a non-manager never POSTs other people (even via a stale picked set) —
      // POST /api/goals would 403 on goal.manage, surfacing as a bogus sign-in error.
      const finalIds = canManageGoals ? participantIds : (viewer ? [viewer.id] : participantIds)
      await api.createGoal({
        title: i.title,
        goalType: i.goalType,
        trackingMode: i.trackingMode,
        participantMode: i.participantMode,
        targetBasis: i.targetBasis,
        targetValue: i.targetValue ?? undefined,
        unit: i.unit ?? undefined,
        deadline: i.deadline ?? undefined,
        participantIds: finalIds,
      }) // apps/web/src/lib/api/goals.ts → POST /api/goals
      return `Added the “${i.title}” goal`
    }
    if (i.kind === 'pantry') {
      await pantryApi.create({
        name: i.name,
        amount: i.amount ?? undefined,
        unit: i.unit ?? undefined,
        location: i.location,
        expiresOn: i.expiresOn ?? undefined,
        lowAt: i.lowAt ?? undefined,
      }) // apps/web/src/lib/api/pantry.ts → POST /api/pantry
      return `Added “${i.name}” to the pantry`
    }
    if (i.kind === 'reward') {
      await api.createReward({
        title: i.title,
        emoji: i.emoji ?? undefined,
        cost: i.cost ?? 0,
        currency: i.currency ?? undefined,
        category: i.category ?? undefined,
        requiresApproval: i.requiresApproval ?? undefined,
      }) // apps/web/src/lib/api/rewards.ts → POST /api/rewards
      return `Added “${i.title}” to the reward shop`
    }
    if (i.kind === 'mutate') {
      // The row was picked in the preview; the server applies the mutation (verb → the
      // module's own service fn) and returns the flash message (or a 4xx we surface).
      const chosen = candidates?.list.find((c) => c.id === chosenId)
      const r = await api.commitMutate({ verb: i.verb, targetKind: i.targetKind, targetId: chosenId!, args: i.args ?? {}, meta: chosen?.meta })
      return r.message
    }
    if (i.kind === 'unsupported') return ''
    await api.createChore({ title: i.title, personId: personId(i.personName), rewardAmount: i.stars ?? undefined, rrule: i.rrule ?? undefined })
    return `Added the “${i.title}” chore${i.personName ? ` for ${i.personName}` : ''}`
  }

  // After a successful commit, ping the event bus so any open view of that data refetches
  // (the capture bar mutates via REST, so a chore/goal/etc. screen would otherwise stay stale
  // until a manual refresh — the bug that motivated this). Events/pantry ride PowerSync/their
  // own refresh and have no bus topic yet.
  function emitAfterCommit(i: ParsedIntent): void {
    const CREATE_TOPIC: Partial<Record<ParsedIntent['kind'], Topic>> = { grocery: 'grocery', meal: 'meals', countdown: 'countdowns', goal: 'goals', reward: 'rewards' }
    const MUTATE_TOPIC: Partial<Record<string, Topic>> = { chore: 'chores', goal: 'goals', listItem: 'grocery', reward: 'rewards' }
    if (i.kind === 'person') { emitHouseholdChanged(); return }
    const topic = i.kind === 'mutate' ? MUTATE_TOPIC[i.targetKind ?? ''] : CREATE_TOPIC[i.kind]
    if (topic) emit(topic)
  }

  async function performCommit(toCommit: ParsedIntent) {
    if (busy) return
    setBusy(true)
    try {
      const msg = await commit(toCommit)
      emitAfterCommit(toCommit)
      setText('')
      setServer(null)
      setDraft(null)
      setCandidates(null)
      setChosenId(null)
      setFlash({ ok: true, msg })
      setTimeout(() => {
        setFlash(null)
        setExpanded(false)
      }, 1500)
    } catch (err) {
      // A mutate commit rethrows the server's human `message` (e.g. "That chore needs a
      // photo…"); surface it. Other commits keep the generic reload/sign-in hint.
      const msg = toCommit.kind === 'mutate' && err instanceof Error && err.message
        ? err.message
        : "Couldn't add that — try reloading or signing in again."
      setFlash({ ok: false, msg })
    } finally {
      setBusy(false)
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !text.trim()) return
    const toCommit = intent
    if (!toCommit) {
      setFlash({ ok: false, msg: 'Couldn’t understand that — try rephrasing.' })
      return
    }
    if (toCommit.kind === 'unsupported') {
      setFlash({ ok: false, msg: toCommit.reason })
      return
    }
    // Enter/↵ commits a non-destructive mutate only once a row is chosen; a `delete`
    // must go through the explicit destructive button in the picker (never Enter).
    if (toCommit.kind === 'mutate' && (!chosenId || toCommit.verb === 'delete')) return
    await performCommit(toCommit)
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      close()
    }
  }

  const preview = intent ? intentSummary(intent) : null
  // A mutate needs a chosen row to commit — and a `delete` is NEVER committable via ↵
  // (only the explicit destructive button), so ↵ stays disabled for it.
  const canCommit = !!intent && intent.kind !== 'unsupported' &&
    (intent.kind !== 'mutate' || (!!chosenId && intent.verb !== 'delete'))

  return (
    <>
      <button type="button" className="ai-bar capture-trigger" onClick={open} style={{ flex: 1, maxWidth: 520 }}>
        <div className="ai-spark">
          <Icon name="spark" />
        </div>
        <span className={`cap-trigger-text ${text ? '' : 'ph'}`}>{text || 'Add anything… “Soccer Tue 4pm for Wally”'}</span>
      </button>

      {expanded &&
        createPortal(
          <div className="cap-overlay" onMouseDown={close}>
            <div className="cap-composer" onMouseDown={(e) => e.stopPropagation()}>
              <form onSubmit={submit}>
                <div className="cap-comp-row">
                  <div className={`ai-spark ${thinking ? 'thinking' : ''}`}>
                    <Icon name="spark" />
                  </div>
                  <textarea
                    ref={taRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={'Add anything…  “fish for dinner next Friday”'}
                    aria-label="Add anything"
                    rows={1}
                    disabled={busy}
                  />
                  <button type="submit" className="cap-go" aria-label="Add" disabled={busy || !text.trim() || !canCommit}>
                    ↵
                  </button>
                </div>
              </form>

              {flash ? (
                <div className={`cap-flash ${flash.ok ? 'ok' : 'err'}`}>
                  {flash.ok ? '✓' : '⚠'} {flash.msg}
                </div>
              ) : thinkingPlaceholder ? (
                <div className="cap-preview cap-thinking">
                  <div className="cap-icon">✦</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cap-kind">Reading that<span className="cap-via">thinking…</span></div>
                    <div className="cap-detail">One sec while I sort it out…</div>
                  </div>
                </div>
              ) : preview && intent ? (
                <div className={`cap-preview ${editing ? 'editing' : ''}`}>
                  <div className="cap-icon">{preview.icon}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cap-kind">
                      {preview.kind}
                      {/* A confident guess is already shown — the model is just
                          refining it, so make clear you can submit now. */}
                      <span className="cap-via">{thinking ? 'improving… · ↵ to add now' : `via ${VIA_LABEL[via] ?? via}`}</span>
                    </div>

                    {intent.kind === 'unsupported' ? (
                      <div className="cap-primary">{intent.reason}</div>
                    ) : intent.kind === 'mutate' ? (
                      <div className="cap-edit">
                        <div className="cap-primary" style={{ whiteSpace: 'normal' }}>{preview.primary}</div>
                        <CandidatePicker intent={intent} state={candidates} chosenId={chosenId} onPick={setChosenId} onCommit={() => void performCommit(intent)} busy={busy} />
                        {/* Mutations lean on matching an existing item. The on-device parser is
                            best-effort (common phrasings only); an AI provider makes "do anything"
                            reliable — so say so plainly whenever we're running without one. */}
                        {via === 'on-device' && (
                          <div className="cap-detail" style={{ marginTop: 6, whiteSpace: 'normal' }}>
                            Matched on-device (no AI key). Add an AI provider in <strong>Settings → AI &amp; capture</strong> for reliable “do anything” results.
                          </div>
                        )}
                      </div>
                    ) : editing ? (
                      <div className="cap-edit">
                        <input className="cap-edit-input" value={primaryOf(intent)} onChange={(e) => setDraft(withPrimary(intent, e.target.value))} aria-label="Edit" autoFocus />
                        <DraftFields intent={intent} persons={persons} lists={customLists} set={setDraft} today={localToday()} viewer={viewer ?? null} canManageGoals={canManageGoals} />
                        <div className="cap-kind-chips">
                          {KINDS.map(({ k, label }) => (
                            <button key={k} type="button" className={`cap-kind-chip ${intent.kind === k ? 'on' : ''}`} onClick={() => setDraft(rerouteKind(intent, k, localToday()))}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="cap-primary cap-primary-btn" onClick={() => setDraft(intent)} title="Tap to edit">
                          {preview.primary}
                          <span className="cap-edit-pencil">✎</span>
                        </button>
                        {preview.detail && <div className="cap-detail">{preview.detail}</div>}
                        {altIntent && (
                          <button type="button" className="cap-switch" onClick={() => setPreferLlm((v) => !v)}>
                            ⇔ {altFrom} reads this as {kindLabel(altIntent.kind)} — switch
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="cap-hint">{editing ? 'editing' : canCommit ? 'press ↵' : ''}</div>
                </div>
              ) : (
                <div className="cap-empty-hint tiny muted">Type an event, list item, chore, grocery, or meal — I’ll sort it out.</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
