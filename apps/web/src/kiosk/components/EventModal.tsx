import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, usePersons, useGoals, goalsApi, goalCalendarApi, calendarsApi, mealsApi, localToday, invalidateGetCache, type AgendaEvent, type CalendarLink, type GoalStep } from '../../lib/api'
import { suggestGoalForEvent } from '../../lib/goal-match'
import { Icon } from '../icons'
import { createEventLocal, updateEventLocal, deleteEventLocal, tombstoneEvent } from '../../lib/powersync/events-local'
import { parseRepeat, buildRrule, describeRrule, weekdayCode, nthWeekdayOfMonth, WEEKDAYS, type RepeatFreq, type CustomUnit, type MonthlyMode } from './recurrence'

// Scope of an edit/delete to a recurring event, surfaced via a small chooser.
type EditScope = 'this' | 'following' | 'all'
const REPEAT_OPTIONS: Array<{ value: RepeatFreq; label: string }> = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom', label: 'Custom…' },
]
const WEEKDAY_LABELS: Record<string, string> = { SU: 'S', MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S' }
const FULL_WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINAL_LABEL = ['', 'first', 'second', 'third', 'fourth', 'fifth']
const clampInterval = (v: string) => Math.max(1, Math.min(99, Math.round(Number(v) || 1)))

// The day-of-week toggle row, shared by the "Weekly" preset and the custom
// "every N weeks" builder. Empty selection falls back to the event's own weekday.
function WeekdayChips({ value, weekday, onChange }: { value: string[]; weekday: string; onChange: (next: string[]) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {WEEKDAYS.map((d) => {
        const on = value.length ? value.includes(d) : d === weekday
        return (
          <button
            type="button"
            key={d}
            aria-pressed={on}
            aria-label={d}
            onClick={() => {
              const base = value.length ? value : [weekday]
              onChange(base.includes(d) ? base.filter((x) => x !== d) : [...base, d])
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 999,
              border: `1.5px solid ${on ? 'var(--primary)' : 'transparent'}`,
              background: on ? 'var(--primary)' : 'var(--card-2)',
              color: on ? '#fff' : 'var(--ink)',
              font: 'inherit',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {WEEKDAY_LABELS[d]}
          </button>
        )
      })}
    </div>
  )
}

// Calendars an event can be written to: writable (owner/writer), not read-only.
function isWritable(c: CalendarLink): boolean {
  return c.accessRole === 'owner' || c.accessRole === 'writer'
}

const pad = (n: number) => String(n).padStart(2, '0')

// Build an ISO instant from a local date + time (browser tz = kiosk/household tz).
function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString()
}

const DURATIONS: Array<{ min: number; label: string }> = [
  { min: 15, label: '15 min' },
  { min: 30, label: '30 min' },
  { min: 45, label: '45 min' },
  { min: 60, label: '1 hr' },
  { min: 90, label: '1.5 hr' },
  { min: 120, label: '2 hr' },
  { min: 180, label: '3 hr' },
  { min: 240, label: '4 hr' },
]

// A new event can be opened with some fields pre-filled — e.g. "Plan time" on a
// goal hands us the goal + its people so the event is linked from the start.
export interface EventPrefill {
  goalId?: string
  goalStepId?: string
  participantIds?: string[]
  title?: string
  durationMin?: number
}

function initialForm(event?: AgendaEvent, date?: string, time?: string, prefill?: EventPrefill) {
  if (event) {
    const d = new Date(event.startsAt)
    const participantIds = event.participants.length
      ? event.participants.map((p) => p.id)
      : event.personId
        ? [event.personId]
        : []
    const durationMin =
      event.endsAt && !event.allDay
        ? Math.max(15, Math.round((new Date(event.endsAt).getTime() - d.getTime()) / 60000))
        : 60
    return {
      title: event.title,
      day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      durationMin,
      allDay: event.allDay,
      isCountdown: event.isCountdown ?? false,
      participantIds,
      location: event.location ?? '',
      // Editing keeps the event's own link; but when it has none, an incoming
      // prefill (e.g. "Link" on a suggestion) seeds the suggested goal.
      goalId: event.goalId ?? prefill?.goalId ?? '',
      goalStepId: event.goalStepId ?? prefill?.goalStepId ?? '',
    }
  }
  return {
    title: prefill?.title ?? '',
    day: date ?? localToday(),
    time: time ?? '17:00',
    durationMin: prefill?.durationMin ?? 60,
    allDay: false,
    isCountdown: false,
    participantIds: prefill?.participantIds ?? ([] as string[]),
    location: '',
    goalId: prefill?.goalId ?? '',
    goalStepId: prefill?.goalStepId ?? '',
  }
}

// Create (pass `date`, optional `time`, optional `prefill`) or edit (pass `event`)
// a calendar event.
export function EventModal({
  event,
  date,
  time,
  prefill,
  onClose,
  onSaved,
}: {
  event?: AgendaEvent
  date?: string
  time?: string
  prefill?: EventPrefill
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!event
  const navigate = useNavigate()
  const { persons } = usePersons()
  // Goals that opted into calendar auto-counting (the "Counts toward" picker).
  // total/count/habit add an amount; a checklist instead ticks a chosen step.
  const { goals } = useGoals()
  const calendarGoals = goals.filter(
    (g) =>
      g.autoFromCalendar &&
      (g.goalType === 'total' || g.goalType === 'count' || g.goalType === 'habit' || g.goalType === 'checklist')
  )
  const [form, setForm] = useState(() => initialForm(event, date, time, prefill))
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  // Recurrence picker state. The end condition (Never / on a date / after N) is
  // separate: COUNT rides in the rrule, an end date rides in recurrenceEndAt. We
  // strip COUNT out of the stored rule before parsing so the freq builder reads
  // cleanly, then re-apply it from the end picker.
  const initialCount = event?.rrule ? /;?COUNT=(\d+)/i.exec(event.rrule)?.[1] ?? null : null
  const [repeat, setRepeat] = useState(() => parseRepeat(event?.rrule?.replace(/;?COUNT=\d+/i, '')))
  const [endMode, setEndMode] = useState<'never' | 'on' | 'after'>(initialCount ? 'after' : 'never')
  const [until, setUntil] = useState('')
  const [count, setCount] = useState(initialCount ? Number(initialCount) : 10)
  const [scopePrompt, setScopePrompt] = useState<null | 'save' | 'delete'>(null)
  const wasRecurring = !!event?.rrule
  // The event's start, used for the default weekly day and monthly nth-weekday.
  const startDate = new Date(`${form.day}T${form.time || '12:00'}`)
  const weekday = weekdayCode(startDate)
  const baseRrule = buildRrule(repeat, startDate)
  // COUNT lives in the rule; an end date is passed separately as recurrenceEndAt.
  const rrule = baseRrule && endMode === 'after' && count > 0 ? `${baseRrule};COUNT=${count}` : baseRrule
  const recurrenceEndAt = endMode === 'on' && until ? toIso(until, '23:59') : undefined
  const ruleSummary = (() => {
    const s = describeRrule(rrule, startDate)
    return endMode === 'on' && until ? `${s}, until ${until}` : s
  })()
  const nowRecurring = !!rrule

  // "Counts toward" is gated on who's attending: with nobody selected there's
  // nothing to attribute, so the picker is hidden. Once people are chosen, only
  // goals that include EVERY selected person show — a goal's participants must be
  // a superset of the attendees (so a family goal still appears when you pick a
  // subset of the family, but a Kevin-only goal won't show once Wally is added).
  const relevantGoals =
    form.participantIds.length === 0
      ? []
      : calendarGoals.filter((g) => {
          const gp = new Set(g.participants.map((p) => p.personId))
          return form.participantIds.every((id) => gp.has(id))
        })
  // If the attendee change orphaned the chosen goal, drop it (and any step) so we
  // never save a link the picker no longer offers. Wait for goals to load first —
  // otherwise a pre-filled goalId (from "Plan time") is cleared before they arrive.
  useEffect(() => {
    if (!goals.length) return
    if (form.goalId && !relevantGoals.some((g) => g.id === form.goalId)) {
      set('goalId', '')
      set('goalStepId', '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.participantIds, form.goalId, goals.length])

  // A checklist goal needs a step to tick — fetch the goal's open steps when one
  // is selected. (The goals list carries only counts, not the step rows.)
  const selectedGoal = calendarGoals.find((g) => g.id === form.goalId)
  const isChecklistGoal = selectedGoal?.goalType === 'checklist'
  const [steps, setSteps] = useState<GoalStep[]>([])
  useEffect(() => {
    if (!isChecklistGoal || !form.goalId) {
      setSteps([])
      return
    }
    let alive = true
    goalsApi
      .goal(form.goalId)
      // Offer the steps still to do — plus, when editing, the one already linked
      // (even if done) so the current selection stays visible.
      .then((d) => alive && setSteps(d.goal.steps.filter((s) => !s.done || s.id === form.goalStepId)))
      .catch(() => alive && setSteps([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChecklistGoal, form.goalId])

  // Drop a stale step when the goal changes to a non-checklist or a different one.
  useEffect(() => {
    if (!isChecklistGoal && form.goalStepId) set('goalStepId', '')
    else if (form.goalStepId && steps.length && !steps.some((s) => s.id === form.goalStepId)) set('goalStepId', '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChecklistGoal, steps])

  // Smart suggestion: when the event is untagged but its title/people look like a
  // goal, offer to link it (the human still taps "Link" — never auto-applied).
  // Only once attendees are chosen, so attribution makes sense.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  // Once the person picks the goal themselves (the dropdown), back off entirely —
  // no chip, no auto-link — and respect their choice for the rest of the session.
  const [userTouchedGoal, setUserTouchedGoal] = useState(false)
  const userTouchedGoalRef = useRef(false)
  userTouchedGoalRef.current = userTouchedGoal
  // When memory is confident enough we pre-fill the goal (auto-link); remember
  // which one so we can show the "we learned this" note next to the picker.
  const [autoLinkedId, setAutoLinkedId] = useState<string | null>(null)
  // Instant client-side keyword/concept match — no network, shows immediately.
  const suggestion = useMemo(() => {
    if (userTouchedGoal || form.goalId || form.participantIds.length === 0 || form.title.trim().length < 3) return null
    const g = suggestGoalForEvent(form.title, null, form.participantIds, calendarGoals)
    return g && !dismissed.has(g.id) ? g : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.goalId, form.title, form.participantIds, calendarGoals, dismissed, userTouchedGoal])

  // LLM fallback: when keywords found nothing (or tied), ask the server's matcher
  // (memory → keyword → LLM). Debounced so it fires on a typing pause, not every
  // keystroke, and cached per (title, people) so it never re-asks the same thing.
  type Sug = { id: string; title: string; emoji: string | null }
  type RawSug = { goalId: string; goalTitle: string; goalEmoji: string | null; auto: boolean }
  const peopleKey = [...form.participantIds].sort().join(',')
  const [llmSug, setLlmSug] = useState<Sug | null>(null)
  const [llmThinking, setLlmThinking] = useState(false)
  // True when a search finished and turned up nothing — so we can say "no match"
  // instead of the spinner just vanishing.
  const [searchedEmpty, setSearchedEmpty] = useState(false)
  const llmCache = useRef<Map<string, RawSug | null>>(new Map())
  // Always consult the server (memory → keyword → LLM), even when the instant
  // client keyword matched — because LEARNED MEMORY must win over a keyword
  // coincidence (e.g. "Trampoline park" keyword-hits a parks goal, but the family
  // has taught us it means "Get active"). The instant client chip shows meanwhile;
  // an `auto` result pre-links and overrides it.
  useEffect(() => {
    if (userTouchedGoal || form.goalId || form.participantIds.length === 0 || form.title.trim().length < 3) {
      setLlmSug(null)
      setLlmThinking(false)
      setSearchedEmpty(false)
      return
    }
    const key = `${form.title.trim().toLowerCase()}|${peopleKey}`
    let alive = true
    const ctrl = new AbortController()
    // auto → pre-link (override the instant chip). Non-auto → only fill the chip
    // when the instant client matcher found nothing (keep instant display for hits).
    const apply = (s: { goalId: string; goalTitle: string; goalEmoji: string | null; auto: boolean } | null) => {
      if (!alive || userTouchedGoalRef.current) return
      if (s?.auto) {
        set('goalId', s.goalId)
        setAutoLinkedId(s.goalId)
        setLlmSug(null)
        setSearchedEmpty(false)
      } else if (!suggestion) {
        setLlmSug(s ? { id: s.goalId, title: s.goalTitle, emoji: s.goalEmoji } : null)
        setSearchedEmpty(!s) // searched, nothing back → show the "no match" note
      }
    }
    setSearchedEmpty(false)
    if (llmCache.current.has(key)) {
      apply(llmCache.current.get(key)!)
      setLlmThinking(false)
      return
    }
    if (!suggestion) setLlmSug(null)
    // Only show the thinking spinner when there's no instant chip to look at.
    setLlmThinking(!suggestion)
    // Cap the wait: a slow local model can take 20s+, which is an unacceptable
    // modal spinner. Bail at 10s and fall back to the "no match" note rather than
    // hang. (The Today drawer keeps the full LLM — it's not latency-sensitive.)
    let settled = false
    const cap = setTimeout(() => {
      if (settled) return
      ctrl.abort()
      if (alive) {
        setLlmThinking(false)
        if (!suggestion) setSearchedEmpty(true)
      }
    }, 10000)
    const timer = setTimeout(async () => {
      try {
        const { suggestion: s } = await goalCalendarApi.suggestOne({ title: form.title.trim(), participantIds: form.participantIds }, ctrl.signal)
        settled = true
        clearTimeout(cap)
        llmCache.current.set(key, s)
        apply(s)
      } catch {
        // Errored or timed out → don't leave the spinner hanging; offer manual pick.
        settled = true
        clearTimeout(cap)
        if (alive && !suggestion) {
          setLlmSug(null)
          setSearchedEmpty(true)
        }
      } finally {
        if (alive) setLlmThinking(false)
      }
    }, 700)
    // Changing attendees/title before the request settles aborts the in-flight one
    // (and cancels the pending debounce) — only ever one query to the matcher.
    return () => {
      alive = false
      clearTimeout(timer)
      clearTimeout(cap)
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, userTouchedGoal, form.goalId, form.title, peopleKey])

  // What the chip shows: the instant keyword match, else the LLM's pick.
  const shownSuggestion: Sug | null = suggestion
    ? { id: suggestion.id, title: suggestion.title, emoji: suggestion.emoji }
    : llmSug && !dismissed.has(llmSug.id)
      ? llmSug
      : null

  // The auto-linked goal (for the "we learned this" note) — only while it's still
  // the selected goal and the person hasn't overridden it.
  const autoLinkedGoal =
    autoLinkedId && form.goalId === autoLinkedId && !userTouchedGoal
      ? calendarGoals.find((g) => g.id === autoLinkedId) ?? null
      : null

  // For a planned-meal event, resolve its recipe so we can offer "View recipe".
  const isMeal = event?.origin === 'meal_plan'
  const [recipeId, setRecipeId] = useState<string | null>(null)
  useEffect(() => {
    if (!isMeal || !event?.originRefId) return
    let alive = true
    mealsApi.entry(event.originRefId).then((r) => alive && setRecipeId(r.recipeId)).catch(() => {})
    return () => { alive = false }
  }, [isMeal, event?.originRefId])

  // Calendar picker (create only): which Google calendar the event is written to.
  // '' = Nook only. Defaults to the owner's ★ calendar and follows the owner until
  // the user picks manually. Editing keeps the event on its existing calendar.
  const [writableCals, setWritableCals] = useState<CalendarLink[]>([])
  const [calendarId, setCalendarId] = useState('')
  const [calTouched, setCalTouched] = useState(false)
  const primary = form.participantIds[0] ?? null

  useEffect(() => {
    if (editing) return
    let alive = true
    calendarsApi
      .calendarStatus()
      .then((s) => alive && setWritableCals(s.calendars.filter(isWritable)))
      .catch(() => {}) // no Google / not signed in → no picker
    return () => {
      alive = false
    }
  }, [editing])

  // The calendars offered for an event: the owner's (first-selected person's) own
  // writable calendars that are syncing — plus their ★ target even if sync is off.
  const ownerCals = primary
    ? writableCals.filter((c) => c.personId === primary && (c.selected || c.isWriteTarget))
    : []

  // Default to the owner's ★ target (then any of their calendars), re-following
  // when the owner changes — until the user picks manually.
  useEffect(() => {
    if (editing || calTouched) return
    const target = ownerCals.find((c) => c.isWriteTarget) ?? ownerCals[0]
    setCalendarId(target?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, calTouched, primary, writableCals])

  // The current form as the shapes the save paths need: `draft` for the local DB
  // (personIds), `restPayload` for REST (participantIds).
  function buildPayloads() {
    const startsAt = form.allDay ? toIso(form.day, '12:00') : toIso(form.day, form.time)
    // Timed events get start + duration; all-day events have no end.
    const endsAt = form.allDay ? null : new Date(new Date(startsAt).getTime() + form.durationMin * 60000).toISOString()
    // Calendar choice only when the picker was shown (owner has >1); else auto-route.
    const chosenCal = !editing && ownerCals.length > 1 ? calendarId || null : null
    const draft = {
      title: form.title.trim(),
      startsAt,
      endsAt,
      allDay: form.allDay,
      isCountdown: form.isCountdown,
      location: form.location.trim() || null,
      personIds: form.participantIds,
      goalId: form.goalId || null,
      // Only a checklist link carries a step; clear it otherwise.
      goalStepId: isChecklistGoal ? form.goalStepId || null : null,
    }
    const restPayload = { ...draft, participantIds: draft.personIds }
    return { draft, restPayload, chosenCal }
  }

  // Save a recurring create/edit through REST (recurring events are server-
  // materialized — the local-first path can't expand the rule). `scope` only
  // applies when editing an already-recurring event.
  async function saveRecurring(scope?: EditScope) {
    const { restPayload } = buildPayloads()
    try {
      if (!editing) {
        await api.createEvent({ ...restPayload, rrule, recurrenceEndAt })
      } else if (wasRecurring) {
        // 'this'/'following' edit only the occurrence's own fields; only 'all'
        // (editing the master) changes the rule itself.
        await api.updateEvent(event!.seriesId ?? event!.id, {
          ...restPayload,
          scope,
          occurrenceStart: event!.occurrenceStart,
          ...(scope === 'all' ? { rrule, recurrenceEndAt } : {}),
        })
        invalidateGetCache(`/api/events/${event!.id}/insight`)
      } else {
        // A single event being made recurring — no scope dialog; promote in place.
        await api.updateEvent(event!.id, { ...restPayload, rrule, recurrenceEndAt })
        invalidateGetCache(`/api/events/${event!.id}/insight`)
      }
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event save failed', err)
      setSaving(false)
      setScopePrompt(null)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    // Recurring create/edit goes through REST. Editing an already-recurring event
    // first asks which occurrences to change.
    if (nowRecurring || wasRecurring) {
      if (editing && wasRecurring) {
        setScopePrompt('save')
        return
      }
      setSaving(true)
      await saveRecurring()
      return
    }
    setSaving(true)
    const { draft, restPayload, chosenCal } = buildPayloads()
    try {
      // Prefer the local DB (instant, offline-capable); fall back to REST when
      // PowerSync isn't running.
      if (editing) {
        if (!(await updateEventLocal(event!.id, draft))) await api.updateEvent(event!.id, restPayload)
        invalidateGetCache(`/api/events/${event!.id}/insight`)
      } else {
        if (!(await createEventLocal({ ...draft, calendarId: chosenCal }))) {
          await api.createEvent(ownerCals.length > 1 ? { ...restPayload, calendarId: chosenCal } : restPayload)
        }
      }
      // The week digest reflects this event — refresh it next time it's shown.
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event save failed', err)
      setSaving(false)
    }
  }

  async function deleteRecurring(scope: EditScope) {
    try {
      if (scope === 'all') {
        await api.deleteEvent(event!.seriesId ?? event!.id)
      } else {
        await api.deleteEvent(event!.seriesId ?? event!.id, { scope, occurrenceStart: event!.occurrenceStart })
      }
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event delete failed', err)
      setSaving(false)
      setScopePrompt(null)
    }
  }

  async function del() {
    if (!editing || saving) return
    // Recurring events choose a scope instead of the tap-again confirm.
    if (wasRecurring) {
      setScopePrompt('delete')
      return
    }
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setSaving(true)
    try {
      // Prefer the local delete (instant, offline); when the row isn't in the local
      // DB yet it returns false and we delete via REST, tombstoning on success so
      // the UI hides it through the refetch/replication window.
      if (!(await deleteEventLocal(event!.id))) {
        await api.deleteEvent(event!.id)
        tombstoneEvent(event!.id)
      }
      invalidateGetCache('/api/calendar/heads-up')
      onSaved()
      onClose()
    } catch (err) {
      console.error('event delete failed', err)
      setSaving(false)
    }
  }

  // The scope chooser picked an option — run the right action and dismiss it.
  function onScopeChosen(scope: EditScope) {
    setSaving(true)
    if (scopePrompt === 'delete') void deleteRecurring(scope)
    else void saveRecurring(scope)
    setScopePrompt(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="nk-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 14 }}>
          {editing ? (isMeal ? 'Planned meal' : 'Edit event') : 'New event'}
        </div>

        {isMeal && recipeId && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginBottom: 14 }}
            onClick={() => { onClose(); navigate(`/meals/recipe/${recipeId}`) }}
          >
            📖 View recipe
          </button>
        )}

        <form onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Soccer practice" autoFocus />
          </label>

          <label className="field">
            <span>Date</span>
            <input type="date" value={form.day} onChange={(e) => set('day', e.target.value)} />
          </label>
          {!form.allDay && (
            <div className="field-row">
              <label className="field">
                <span>Time</span>
                <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
              </label>
              <label className="field">
                <span>Duration</span>
                <select value={form.durationMin} onChange={(e) => set('durationMin', Number(e.target.value))}>
                  {DURATIONS.map((d) => (
                    <option key={d.min} value={d.min}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ margin: 0 }}>All day</span>
          </label>

          <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.isCountdown} onChange={(e) => set('isCountdown', e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ margin: 0 }}>⏳ Show a countdown (build anticipation)</span>
          </label>

          {/* One box for the whole repeat rule — frequency, the custom builder, and
              the end condition are all facets of the same thing, so they live
              together rather than in separate cards. */}
          <div className="field">
            <span>Repeats</span>
            <select
              value={repeat.freq}
              onChange={(e) => setRepeat((r) => ({ ...r, freq: e.target.value as RepeatFreq }))}
              style={{ width: '100%' }}
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            {/* Weekly preset → which days (defaults to the event's own weekday). */}
            {repeat.freq === 'weekly' && (
              <div className="rep-grp">
                <span className="rep-sub">On days</span>
                <WeekdayChips value={repeat.byday} weekday={weekday} onChange={(next) => setRepeat((r) => ({ ...r, byday: next }))} />
              </div>
            )}

            {/* Custom → a friendly "every N units" builder (no RRULE typing). Weekly
                shows day chips; monthly offers day-of-month / Nth / last weekday.
                The raw rule stays under Advanced for power users / imports. */}
            {repeat.freq === 'custom' && (
              <div className="rep-grp">
                <span className="rep-sub">Repeat every</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={repeat.interval}
                    onChange={(e) => setRepeat((r) => ({ ...r, interval: clampInterval(e.target.value) }))}
                    aria-label="Interval"
                    style={{ width: 76 }}
                  />
                  <select
                    value={repeat.unit}
                    onChange={(e) => setRepeat((r) => ({ ...r, unit: e.target.value as CustomUnit }))}
                    aria-label="Unit"
                    style={{ flex: 1 }}
                  >
                    <option value="day">{repeat.interval === 1 ? 'day' : 'days'}</option>
                    <option value="week">{repeat.interval === 1 ? 'week' : 'weeks'}</option>
                    <option value="month">{repeat.interval === 1 ? 'month' : 'months'}</option>
                    <option value="year">{repeat.interval === 1 ? 'year' : 'years'}</option>
                  </select>
                </div>

                {repeat.unit === 'week' && (
                  <div style={{ marginTop: 10 }}>
                    <WeekdayChips value={repeat.byday} weekday={weekday} onChange={(next) => setRepeat((r) => ({ ...r, byday: next }))} />
                  </div>
                )}

                {repeat.unit === 'month' && (
                  <select
                    value={repeat.monthlyMode}
                    onChange={(e) => setRepeat((r) => ({ ...r, monthlyMode: e.target.value as MonthlyMode }))}
                    aria-label="Monthly pattern"
                    style={{ marginTop: 10, width: '100%' }}
                  >
                    <option value="day">On day {startDate.getDate()}</option>
                    <option value="weekday">On the {ORDINAL_LABEL[nthWeekdayOfMonth(startDate)] ?? `${nthWeekdayOfMonth(startDate)}th`} {FULL_WEEKDAY[startDate.getDay()]}</option>
                    <option value="lastWeekday">On the last {FULL_WEEKDAY[startDate.getDay()]}</option>
                  </select>
                )}

                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--ink-2)' }}>Advanced (raw RRULE)</summary>
                  <input
                    style={{ marginTop: 8 }}
                    value={repeat.custom}
                    onChange={(e) => setRepeat((r) => ({ ...r, custom: e.target.value }))}
                    placeholder="FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"
                    aria-label="Custom RRULE"
                  />
                </details>
              </div>
            )}

            {/* End condition — COUNT rides in the rule, a date in recurrenceEndAt. */}
            {repeat.freq !== 'none' && (
              <div className="rep-grp">
                <span className="rep-sub">Ends</span>
                <select value={endMode} onChange={(e) => setEndMode(e.target.value as 'never' | 'on' | 'after')} style={{ width: '100%' }}>
                  <option value="never">Never</option>
                  <option value="on">On a date</option>
                  <option value="after">After a number of times</option>
                </select>
                {endMode === 'on' && (
                  <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={{ marginTop: 8 }} />
                )}
                {endMode === 'after' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <input
                      type="number"
                      min={1}
                      max={730}
                      value={count}
                      onChange={(e) => setCount(Math.max(1, Math.min(730, Math.round(Number(e.target.value) || 1))))}
                      aria-label="Number of occurrences"
                      style={{ width: 76 }}
                    />
                    <span className="muted">times</span>
                  </div>
                )}
              </div>
            )}

            {/* One live plain-English summary for the whole rule, at the bottom. */}
            {repeat.freq !== 'none' && <div className="tiny muted rep-summary">↻ {ruleSummary}</div>}
          </div>

          <div className="field">
            <span>Who</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {persons.map((p) => {
                const on = form.participantIds.includes(p.id)
                const color = p.colorHex ?? '#6B6B70'
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() =>
                      set(
                        'participantIds',
                        on ? form.participantIds.filter((x) => x !== p.id) : [...form.participantIds, p.id]
                      )
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 999,
                      // Always 1.5px so toggling only swaps the color — no size shift.
                      border: `1.5px solid ${on ? color : 'transparent'}`,
                      background: on ? `${color}22` : 'var(--card-2)',
                      color: 'var(--ink)',
                      font: 'inherit',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {p.avatarEmoji ?? '🙂'} {p.name}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Only worth choosing when the owner has more than one calendar; with
              a single one we just use it. */}
          {!editing && ownerCals.length > 1 && (
            <label className="field">
              <span>Calendar</span>
              <select
                value={calendarId}
                onChange={(e) => {
                  setCalendarId(e.target.value)
                  setCalTouched(true)
                }}
                style={{ width: '100%' }}
              >
                {ownerCals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary ?? 'Calendar'}
                    {c.isWriteTarget ? ' ★' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Location (optional)</span>
            <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Field 3" />
          </label>

          {/* Smart suggestion — an untagged event that looks like a goal. The
              instant keyword match shows immediately; if it found nothing we ask
              the AI (spark bounces while it thinks). One tap links it; ✕ dismisses. */}
          {!shownSuggestion && llmThinking && (
            <div className="ev-suggest ev-suggest-thinking">
              <span className="ai-spark thinking"><Icon name="spark" /></span>
              <span className="ev-suggest-txt">Looking for a goal this counts toward…</span>
            </div>
          )}
          {/* Searched, nothing fit — say so (and let them pick below) instead of
              the spinner just disappearing. Only when there were goals to match. */}
          {!shownSuggestion && !autoLinkedGoal && !llmThinking && searchedEmpty && relevantGoals.length > 0 && (
            <div className="ev-suggest ev-suggest-none">
              <span className="ev-suggest-txt muted">No matching goal — pick one below if it counts.</span>
            </div>
          )}
          {shownSuggestion && (
            <div className="ev-suggest">
              <span className="ai-spark"><Icon name="spark" /></span>
              <span className="ev-suggest-txt">
                Looks like this counts toward{' '}
                <b>{shownSuggestion.emoji ? `${shownSuggestion.emoji} ` : ''}{shownSuggestion.title}</b>
              </span>
              <button type="button" className="ev-suggest-link" onClick={() => set('goalId', shownSuggestion.id)}>
                Link
              </button>
              <button
                type="button"
                className="ev-suggest-x"
                aria-label="Dismiss suggestion"
                onClick={() => setDismissed((d) => new Set(d).add(shownSuggestion.id))}
              >
                ✕
              </button>
            </div>
          )}

          {/* Calendar → goal: tag the event so its completion can count toward a
              goal. Shown only once attendees are chosen and they share an
              auto-counting goal. After the event ends, a "did this happen?" recap
              confirms it. */}
          {/* Auto-linked: memory was confident enough to pre-fill the goal below.
              It's a normal selection — change it (or pick "No goal") to override. */}
          {autoLinkedGoal && (
            <div className="ev-suggest ev-suggest-auto">
              <span className="ai-spark"><Icon name="spark" /></span>
              <span className="ev-suggest-txt">
                Auto-linked to <b>{autoLinkedGoal.emoji ? `${autoLinkedGoal.emoji} ` : ''}{autoLinkedGoal.title}</b> — we’ve learned this. Change it below if needed.
              </span>
            </div>
          )}

          {relevantGoals.length > 0 && (
            <label className="field">
              <span>Counts toward (optional)</span>
              <select
                value={form.goalId}
                onChange={(e) => {
                  set('goalId', e.target.value)
                  setUserTouchedGoal(true)
                  setAutoLinkedId(null)
                }}
                style={{ width: '100%' }}
              >
                <option value="">No goal</option>
                {relevantGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.emoji ? `${g.emoji} ` : ''}
                    {g.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Checklist goal → pick which step this event completes; confirming the
              post-event recap ticks it. Hidden once every step is already done. */}
          {isChecklistGoal && steps.length > 0 && (
            <label className="field">
              <span>Completes step</span>
              <select value={form.goalStepId} onChange={(e) => set('goalStepId', e.target.value)} style={{ width: '100%' }}>
                <option value="">No specific step</option>
                {steps.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.done ? '✓ ' : ''}
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div style={{ display: 'flex', gap: 9, marginTop: 6, alignItems: 'center' }}>
            {editing && (
              <button
                type="button"
                onClick={del}
                disabled={saving}
                style={{
                  border: 0,
                  background: 'none',
                  font: 'inherit',
                  fontWeight: 700,
                  fontSize: 14,
                  color: 'var(--primary)',
                  cursor: 'pointer',
                  padding: '10px 4px',
                }}
              >
                {confirmDelete ? 'Tap again to delete' : 'Delete'}
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!form.title.trim() || saving}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {saving ? 'Saving…' : editing ? 'Save' : 'Add event'}
            </button>
          </div>
        </form>

        {/* Recurring edit/delete scope chooser — which occurrences the action
            applies to. Sits over the modal as a small overlay. */}
        {scopePrompt && (
          <div className="modal-overlay" onClick={() => { setScopePrompt(null); setSaving(false) }}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
              <div className="nk-serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 14 }}>
                {scopePrompt === 'delete' ? 'Delete recurring event' : 'Edit recurring event'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <button type="button" className="btn btn-ghost" style={{ justifyContent: 'center' }} onClick={() => onScopeChosen('this')}>
                  This event
                </button>
                <button type="button" className="btn btn-ghost" style={{ justifyContent: 'center' }} onClick={() => onScopeChosen('following')}>
                  This and following events
                </button>
                <button type="button" className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={() => onScopeChosen('all')}>
                  All events
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
