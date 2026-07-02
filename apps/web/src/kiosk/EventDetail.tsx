import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { EventModal } from './components/EventModal'
import { useTopbarFull } from './topbar-slot'
import { api, eventsApi, useEvent, useEventsRange, useHousehold, useGoals, mealsApi, invalidateGetCache, type AgendaEvent } from '../lib/api'
import { deleteEventLocal, tombstoneEvent } from '../lib/powersync/events-local'
import { suggestGoalForEvent } from '../lib/goal-match'
import { describeRrule } from './components/recurrence'
import { DOW_FULL, MONTHS, fmtTime, durationMin, eventPeople, localDate, eventDetailPath } from './components/cal-utils'

function durationLabel(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60} hr`
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`
}

// Relative gap label between a row event and the focused event ("1.5 hr later").
function gapLabel(rowStart: string, thisStart: string): string {
  const diff = new Date(rowStart).getTime() - new Date(thisStart).getTime()
  if (Math.abs(diff) < 60000) return ''
  const mins = Math.round(Math.abs(diff) / 60000)
  const word = diff < 0 ? 'before' : 'later'
  if (mins < 60) return `${mins} min ${word}`
  const hrs = mins / 60
  const h = hrs % 1 === 0 ? `${hrs}` : hrs.toFixed(1)
  return `${h} hr${hrs === 1 ? '' : 's'} ${word}`
}

// The same-day timeline ("Where it falls today") with this event highlighted.
function DayTimeline({ event, tz }: { event: AgendaEvent; tz: string }) {
  const navigate = useNavigate()
  const day = localDate(event.startsAt, tz)
  const { events } = useEventsRange(day, day)
  const sorted = [...events].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
  const idx = sorted.findIndex((e) => e.id === event.id)
  const conflict = sorted.some((e) => {
    if (e.id === event.id || e.allDay || event.allDay) return false
    const aS = new Date(event.startsAt).getTime()
    const aE = aS + durationMin(event) * 60000
    const bS = new Date(e.startsAt).getTime()
    const bE = bS + durationMin(e) * 60000
    return aS < bE && bS < aE
  })

  return (
    <div className="card ed-fall">
      <div className="card-h" style={{ marginBottom: 12 }}>Where it falls today</div>
      {sorted.map((e) => {
        const me = e.id === event.id
        const color = e.personColor ?? '#A6A29B'
        return (
          <div
            key={e.id}
            className={`ed-fall-row ${me ? 'me' : 'clickable'}`}
            role={me ? undefined : 'button'}
            tabIndex={me ? undefined : 0}
            onClick={me ? undefined : () => navigate(eventDetailPath(e))}
          >
            <div className="ed-fall-time">{e.allDay ? 'all day' : fmtTime(e)}</div>
            <div className="ed-fall-bar" style={{ background: color }} />
            <div className="ed-fall-title">{e.title}</div>
            {me ? <span className="ed-fall-tag">this event</span> : <span className="muted ed-fall-gap">{gapLabel(e.startsAt, event.startsAt)}</span>}
          </div>
        )
      })}
      <div className="ed-fall-foot muted">
        {conflict ? 'Heads up — this overlaps another event.' : idx >= 0 ? "No conflicts — you're clear right before & after." : ''}
      </div>
    </div>
  )
}

export function EventDetail() {
  const { id = '' } = useParams()
  // A recurring occurrence opens its series (id) with the slot in `?on=` — used to
  // show the right date and scope edits/deletes to just this one.
  const [searchParams] = useSearchParams()
  const occurrenceOn = searchParams.get('on')
  const navigate = useNavigate()
  const { event, loading, notFound, refetch } = useEvent(id)
  const { household } = useHousehold()
  const { goals } = useGoals()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [editing, setEditing] = useState(false)
  const [editGoalId, setEditGoalId] = useState<string | null>(null)
  const [dismissedSuggest, setDismissedSuggest] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Real AI insight for this event (headline + practical tip + a reminder nudge),
  // via the household's chosen provider with a deterministic server fallback. The
  // "Remind me" button reveals the suggested nudge inline (no delivery yet).
  type Insight = { headline: string; body: string; leaveBy: string | null; reminder: string }
  const [insight, setInsight] = useState<Insight | null>(null)
  const [remindShown, setRemindShown] = useState(false)
  useEffect(() => {
    if (!id) return
    let alive = true
    setInsight(null)
    setRemindShown(false)
    eventsApi.eventInsight(id).then((d) => alive && setInsight(d)).catch(() => {})
    return () => { alive = false }
  }, [id])

  // Resolve the recipe for a planned-meal event so we can offer "View recipe".
  const isMeal = event?.origin === 'meal_plan'
  const [recipeId, setRecipeId] = useState<string | null>(null)
  useEffect(() => {
    if (!isMeal || !event?.originRefId) return
    let alive = true
    mealsApi.entry(event.originRefId).then((r) => alive && setRecipeId(r.recipeId)).catch(() => {})
    return () => { alive = false }
  }, [isMeal, event?.originRefId])

  async function del() {
    if (deleting) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setDeleting(true)
    try {
      if (event?.rrule && occurrenceOn) {
        // Viewing one occurrence of a series → delete just this one (cancel it).
        // Series-wide deletes go through Edit → the modal's this/following/all chooser.
        await api.deleteEvent(id, { scope: 'this', occurrenceStart: occurrenceOn })
      } else if (!(await deleteEventLocal(id))) {
        await api.deleteEvent(id)
        tombstoneEvent(id)
      }
      invalidateGetCache('/api/calendar/heads-up')
      navigate('/calendar')
    } catch {
      setDeleting(false)
    }
  }

  // Topbar: back + Delete / Edit / Remind me (the detail screen owns the whole bar).
  useTopbarFull(
    () => (
      <div className="ed-topbar">
        <button type="button" className="pill" onClick={() => navigate('/calendar')}>
          ‹ Calendar
        </button>
        <div className="ed-actions">
          <button type="button" className="pill" onClick={del}>
            🗑 {confirmDelete ? 'Confirm' : event?.rrule && occurrenceOn ? 'Delete this' : 'Delete'}
          </button>
          <button type="button" className="pill" onClick={() => setEditing(true)}>
            ✎ Edit
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setRemindShown(true)}>
            ⏰ Remind me
          </button>
        </div>
      </div>
    ),
    [confirmDelete, deleting, id, event?.rrule, occurrenceOn]
  )

  if (loading && !event) return <div className="muted" style={{ padding: 40 }}>Loading…</div>
  if (notFound || !event) return <div className="muted" style={{ padding: 40 }}>This event no longer exists.</div>

  // For a recurring occurrence (opened via ?on=), show THIS slot's date/time and
  // carry the series id + slot into edits/deletes — the loaded `event` is the
  // master, whose own date is the series' first occurrence.
  const view: AgendaEvent =
    event.rrule && occurrenceOn
      ? {
          ...event,
          startsAt: occurrenceOn,
          endsAt: event.endsAt ? new Date(new Date(occurrenceOn).getTime() + durationMin(event) * 60_000).toISOString() : null,
          seriesId: event.id,
          occurrenceStart: occurrenceOn,
        }
      : event

  const color = view.personColor ?? '#6B6B70'
  const start = new Date(view.startsAt)
  const people = eventPeople(view)
  const calStatus =
    view.calendarName
      ? `${view.calendarName}${view.syncState === 'synced' ? ' · synced from Google' : ' · pending sync'}`
      : 'Kinnook only'

  // Smart suggestion for an untagged, non-meal, single event that looks like a
  // goal. "Link" opens the editor pre-linked so the human confirms (and can pick
  // a checklist step). Hidden once dismissed or if the event is already linked.
  const attendeeIds = view.participants.length ? view.participants.map((p) => p.id) : view.personId ? [view.personId] : []
  const suggestedGoal =
    !view.goalId && !view.rrule && view.origin !== 'meal_plan' && !dismissedSuggest
      ? suggestGoalForEvent(view.title, null, attendeeIds, goals)
      : null

  return (
    <div className="ed-screen">
      <div className="ed-main">
        <div className="ed-hero" style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}>
          {view.personName && (
            <span className="ed-hero-who">
              {view.personEmoji ?? '🙂'} {view.personName}
            </span>
          )}
          <div className="ed-hero-title nk-serif">{view.title}</div>
          <div className="ed-hero-when">
            {view.allDay ? (
              <span className="ed-hero-time">All day</span>
            ) : (
              <span className="ed-hero-time">{fmtTime(view)}</span>
            )}
            <span className="ed-hero-date">
              {DOW_FULL[start.getDay()]}, {MONTHS[start.getMonth()]} {start.getDate()}
              {!view.allDay && ` · ${durationLabel(durationMin(view))}`}
            </span>
          </div>
        </div>

        {suggestedGoal && (
          <div className="ed-suggest">
            <span className="ed-suggest-spark">✨</span>
            <span className="ed-suggest-txt">
              Looks like this counts toward{' '}
              <b>{suggestedGoal.emoji ? `${suggestedGoal.emoji} ` : ''}{suggestedGoal.title}</b>
            </span>
            <button
              type="button"
              className="btn btn-primary ed-suggest-link"
              onClick={() => {
                setEditGoalId(suggestedGoal.id)
                setEditing(true)
              }}
            >
              Link it
            </button>
            <button type="button" className="ed-suggest-x" aria-label="Dismiss" onClick={() => setDismissedSuggest(true)}>
              ✕
            </button>
          </div>
        )}

        <div className="card ed-rows">
          {isMeal && recipeId && (
            <button type="button" className="ed-row ed-row-btn" onClick={() => navigate(`/meals/recipe/${recipeId}`)}>
              <span className="ed-row-ic">📖</span>
              <span className="ed-row-main"><span className="ed-row-k">Recipe</span><span className="ed-row-v">View the recipe</span></span>
              <span className="ed-row-go">›</span>
            </button>
          )}
          {view.location && (
            <div className="ed-row">
              <span className="ed-row-ic">📍</span>
              <span className="ed-row-main"><span className="ed-row-k">Location</span><span className="ed-row-v">{view.location}</span></span>
              <a
                className="pill ed-row-act"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(view.location)}`}
                target="_blank"
                rel="noreferrer"
              >
                Directions
              </a>
            </div>
          )}
          <div className="ed-row">
            <span className="ed-row-ic">📅</span>
            <span className="ed-row-main"><span className="ed-row-k">Calendar</span><span className="ed-row-v">{calStatus}</span></span>
            {view.syncState === 'synced' && <span className="ed-dot" style={{ background: color }} />}
          </div>
          {view.rrule && (
            <div className="ed-row">
              <span className="ed-row-ic">🔁</span>
              <span className="ed-row-main"><span className="ed-row-k">Repeats</span><span className="ed-row-v">{describeRrule(view.rrule, new Date(view.startsAt))}</span></span>
            </div>
          )}
          {people.length > 0 && (
            <div className="ed-row">
              <span className="ed-row-ic">👥</span>
              <span className="ed-row-main">
                <span className="ed-row-k">With</span>
                <span className="ed-row-v">{people.map((p) => p.name).filter(Boolean).join(' · ')}</span>
              </span>
              <span className="ed-row-avs">
                {people.slice(0, 4).map((p, i) => (
                  <span key={p.id} className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22`, marginLeft: i ? -8 : 0 }}>
                    {p.avatarEmoji ?? '🙂'}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>

        {view.description && (
          <div className="card ed-notes">
            <div className="card-h" style={{ marginBottom: 8 }}>Notes</div>
            <div className="ed-notes-b">{view.description}</div>
          </div>
        )}
      </div>

      <div className="ed-side">
        <div className="ed-ai">
          <div className={`ed-ai-icon ${insight ? '' : 'thinking'}`}>✦</div>
          <div className="ed-ai-main">
            {insight ? (
              <>
                <div className="ed-ai-h">{insight.headline}</div>
                <div className="ed-ai-b">{insight.body}</div>
                {insight.leaveBy && <div className="ed-ai-chip">🚗 Leave by {insight.leaveBy}</div>}
              </>
            ) : (
              // Don't assert a headline before the model has decided — shimmer it too.
              <div className="ai-think" aria-label="Thinking…">
                <div className="ai-think-bar head" />
                <div className="ai-think-bar" />
                <div className="ai-think-bar short" />
              </div>
            )}
            {remindShown && (
              <div className="ed-ai-reminder">
                ⏰ {insight ? insight.reminder : 'One moment…'}
                <span className="tiny muted"> · reminders don’t fire yet — coming soon</span>
              </div>
            )}
          </div>
        </div>

        <DayTimeline event={view} tz={tz} />
      </div>

      {editing && (
        <EventModal
          event={view}
          prefill={editGoalId ? { goalId: editGoalId } : undefined}
          onClose={() => {
            setEditing(false)
            setEditGoalId(null)
          }}
          onSaved={refetch}
        />
      )}
    </div>
  )
}
