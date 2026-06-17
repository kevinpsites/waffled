import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { EventModal } from './components/EventModal'
import { useTopbarFull } from './topbar-slot'
import { api, eventsApi, useEvent, useEventsRange, useHousehold, mealsApi, invalidateGetCache, type AgendaEvent } from '../lib/api'
import { deleteEventLocal, tombstoneEvent } from '../lib/powersync/events-local'
import { DOW_FULL, MONTHS, fmtTime, durationMin, eventPeople, localDate } from './components/cal-utils'

function durationLabel(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60} hr`
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} hr ${mins % 60} min`
}

function repeatLabel(rrule: string): string {
  const freq = /FREQ=([A-Z]+)/.exec(rrule)?.[1]
  if (freq === 'DAILY') return 'Every day'
  if (freq === 'WEEKLY') return 'Every week on this day'
  if (freq === 'MONTHLY') return 'Every month'
  if (freq === 'YEARLY') return 'Every year'
  return 'Repeats'
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
            onClick={me ? undefined : () => navigate(`/calendar/event/${e.id}`)}
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
  const navigate = useNavigate()
  const { event, loading, notFound, refetch } = useEvent(id)
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [editing, setEditing] = useState(false)
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
      if (!(await deleteEventLocal(id))) {
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
            🗑 {confirmDelete ? 'Confirm' : 'Delete'}
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
    [confirmDelete, deleting, id]
  )

  if (loading && !event) return <div className="muted" style={{ padding: 40 }}>Loading…</div>
  if (notFound || !event) return <div className="muted" style={{ padding: 40 }}>This event no longer exists.</div>

  const color = event.personColor ?? '#6B6B70'
  const start = new Date(event.startsAt)
  const people = eventPeople(event)
  const calStatus =
    event.calendarName
      ? `${event.calendarName}${event.syncState === 'synced' ? ' · synced from Google' : ' · pending sync'}`
      : 'Nook only'

  return (
    <div className="ed-screen">
      <div className="ed-main">
        <div className="ed-hero" style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}>
          {event.personName && (
            <span className="ed-hero-who">
              {event.personEmoji ?? '🙂'} {event.personName}
            </span>
          )}
          <div className="ed-hero-title nk-serif">{event.title}</div>
          <div className="ed-hero-when">
            {event.allDay ? (
              <span className="ed-hero-time">All day</span>
            ) : (
              <span className="ed-hero-time">{fmtTime(event)}</span>
            )}
            <span className="ed-hero-date">
              {DOW_FULL[start.getDay()]}, {MONTHS[start.getMonth()]} {start.getDate()}
              {!event.allDay && ` · ${durationLabel(durationMin(event))}`}
            </span>
          </div>
        </div>

        <div className="card ed-rows">
          {isMeal && recipeId && (
            <button type="button" className="ed-row ed-row-btn" onClick={() => navigate(`/meals/recipe/${recipeId}`)}>
              <span className="ed-row-ic">📖</span>
              <span className="ed-row-main"><span className="ed-row-k">Recipe</span><span className="ed-row-v">View the recipe</span></span>
              <span className="ed-row-go">›</span>
            </button>
          )}
          {event.location && (
            <div className="ed-row">
              <span className="ed-row-ic">📍</span>
              <span className="ed-row-main"><span className="ed-row-k">Location</span><span className="ed-row-v">{event.location}</span></span>
              <a
                className="pill ed-row-act"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
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
            {event.syncState === 'synced' && <span className="ed-dot" style={{ background: color }} />}
          </div>
          {event.rrule && (
            <div className="ed-row">
              <span className="ed-row-ic">🔁</span>
              <span className="ed-row-main"><span className="ed-row-k">Repeats</span><span className="ed-row-v">{repeatLabel(event.rrule)}</span></span>
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

        {event.description && (
          <div className="card ed-notes">
            <div className="card-h" style={{ marginBottom: 8 }}>Notes</div>
            <div className="ed-notes-b">{event.description}</div>
          </div>
        )}
      </div>

      <div className="ed-side">
        <div className="ed-ai">
          <div className={`ed-ai-icon ${insight ? '' : 'thinking'}`}>✦</div>
          <div className="ed-ai-main">
            <div className="ed-ai-h">{insight?.headline ?? (event.location ? 'Plan your trip' : 'Stay on track')}</div>
            {insight ? (
              <div className="ed-ai-b">{insight.body}</div>
            ) : (
              <div className="ai-think" aria-label="Thinking…">
                <div className="ai-think-bar" />
                <div className="ai-think-bar short" />
              </div>
            )}
            {insight?.leaveBy && (
              <div className="ed-ai-chip">🚗 Leave by {insight.leaveBy}</div>
            )}
            {remindShown && (
              <div className="ed-ai-reminder">
                ⏰ {insight ? insight.reminder : 'One moment…'}
                <span className="tiny muted"> · reminders don’t fire yet — coming soon</span>
              </div>
            )}
          </div>
        </div>

        <DayTimeline event={event} tz={tz} />
      </div>

      {editing && <EventModal event={event} onClose={() => setEditing(false)} onSaved={refetch} />}
    </div>
  )
}
