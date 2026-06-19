import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api, usePersons, useGoals, goalsApi, goalCalendarApi, calendarsApi, mealsApi, localToday, invalidateGetCache, type AgendaEvent, type CalendarLink, type GoalStep } from '../../lib/api'
import { suggestGoalForEvent } from '../../lib/goal-match'
import { Icon } from '../icons'
import { createEventLocal, updateEventLocal, deleteEventLocal, tombstoneEvent } from '../../lib/powersync/events-local'

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
  // Instant client-side keyword/concept match — no network, shows immediately.
  const suggestion = useMemo(() => {
    if (form.goalId || form.participantIds.length === 0 || form.title.trim().length < 3) return null
    const g = suggestGoalForEvent(form.title, null, form.participantIds, calendarGoals)
    return g && !dismissed.has(g.id) ? g : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.goalId, form.title, form.participantIds, calendarGoals, dismissed])

  // LLM fallback: when keywords found nothing (or tied), ask the server's matcher
  // (memory → keyword → LLM). Debounced so it fires on a typing pause, not every
  // keystroke, and cached per (title, people) so it never re-asks the same thing.
  type Sug = { id: string; title: string; emoji: string | null }
  const peopleKey = [...form.participantIds].sort().join(',')
  const [llmSug, setLlmSug] = useState<Sug | null>(null)
  const [llmThinking, setLlmThinking] = useState(false)
  const llmCache = useRef<Map<string, Sug | null>>(new Map())
  useEffect(() => {
    if (suggestion || form.goalId || form.participantIds.length === 0 || form.title.trim().length < 3) {
      setLlmSug(null)
      setLlmThinking(false)
      return
    }
    const key = `${form.title.trim().toLowerCase()}|${peopleKey}`
    if (llmCache.current.has(key)) {
      setLlmSug(llmCache.current.get(key)!)
      setLlmThinking(false)
      return
    }
    let alive = true
    setLlmSug(null)
    setLlmThinking(true)
    const timer = setTimeout(async () => {
      try {
        const { suggestion: s } = await goalCalendarApi.suggestOne({ title: form.title.trim(), participantIds: form.participantIds })
        const val: Sug | null = s ? { id: s.goalId, title: s.goalTitle, emoji: s.goalEmoji } : null
        llmCache.current.set(key, val)
        if (alive) setLlmSug(val)
      } catch {
        if (alive) setLlmSug(null)
      } finally {
        if (alive) setLlmThinking(false)
      }
    }, 700)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, form.goalId, form.title, peopleKey])

  // What the chip shows: the instant keyword match, else the LLM's pick.
  const shownSuggestion: Sug | null = suggestion
    ? { id: suggestion.id, title: suggestion.title, emoji: suggestion.emoji }
    : llmSug && !dismissed.has(llmSug.id)
      ? llmSug
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

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
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
      location: form.location.trim() || null,
      personIds: form.participantIds,
      goalId: form.goalId || null,
      // Only a checklist link carries a step; clear it otherwise.
      goalStepId: isChecklistGoal ? form.goalStepId || null : null,
    }
    const restPayload = { ...draft, participantIds: draft.personIds }
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

  async function del() {
    if (!editing || saving) return
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
          {relevantGoals.length > 0 && (
            <label className="field">
              <span>Counts toward (optional)</span>
              <select value={form.goalId} onChange={(e) => set('goalId', e.target.value)} style={{ width: '100%' }}>
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
      </div>
    </div>
  )
}
