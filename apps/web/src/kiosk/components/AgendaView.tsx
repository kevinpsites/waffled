import { useEffect, useMemo, useState } from 'react'
import { usePersons, useHousehold, eventsApi, type AgendaEvent } from '../../lib/api'
import { useEventColor } from '../../lib/event-color'
import { Icon } from '../icons'
import { RhythmMark } from './RhythmMark'
import { DayPicker } from './DayPicker'
import { eventDayKeys } from './month-spans'
import {
  ymd, addDays, startOfWeek, fmtTime, eventPeople,
} from './cal-utils'

// A day's worth of upcoming events, with a friendly header.
function dayLabel(d: Date, today: Date): string {
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'long' })
}

// An event is "past" once its end time (or start + 1h when open-ended) is behind
// now — used to subtly fade events that should already be done. All-day events
// aren't time-bound, so they're never faded.
export function isPastEvent(e: AgendaEvent, now: Date): boolean {
  if (e.allDay) return false
  const end = e.endsAt ? new Date(e.endsAt) : new Date(new Date(e.startsAt).getTime() + 60 * 60000)
  return end.getTime() < now.getTime()
}

// `color` comes from useEventColor (family-aware) where the caller has it; the
// plain owner color is the fallback for callers that don't.
export function AgendaRow({ event, past = false, color: colorProp, onClick }: { event: AgendaEvent; past?: boolean; color?: string; onClick: () => void }) {
  const color = colorProp ?? event.personColor ?? '#A6A29B'
  const people = eventPeople(event)
  const lead = people[0]
  return (
    <div className={`ag-row ${past ? 'past' : ''}`} onClick={onClick} role="button" tabIndex={0}>
      <div className="ag-time">{event.allDay ? 'all day' : fmtTime(event)}</div>
      <div className="ag-bar" style={{ background: color }} />
      <div className="ag-main">
        <div className="ag-title"><RhythmMark event={event} />{event.title}</div>
        {event.location && <div className="tiny muted">📍 {event.location}</div>}
      </div>
      {lead && (
        <div className="av sm" style={{ background: `${lead.colorHex ?? '#A6A29B'}22` }}>{lead.avatarEmoji ?? '🙂'}</div>
      )}
    </div>
  )
}

// Small month grid in the sidebar with per-day event dots; clicking a day jumps
// the calendar to that week.
function MiniMonth({ events, tz, colorOf, onPickDate, firstDay }: { events: AgendaEvent[]; tz: string; colorOf: (e: AgendaEvent) => string; onPickDate: (d: Date) => void; firstDay: number }) {
  const dots = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const e of events) {
      for (const k of eventDayKeys(e, tz)) (map[k] ??= new Set()).add(colorOf(e))
    }
    return map
  }, [events, tz, colorOf])

  return (
    <DayPicker
      className="card ag-mini"
      firstDay={firstDay}
      dotsFor={(key) => (dots[key] ? [...dots[key]] : undefined)}
      onPick={(key) => onPickDate(new Date(`${key}T00:00:00`))}
    />
  )
}

// "Heads up this week" — a real digest from the household's AI provider (with a
// deterministic server-side fallback, so it always says something useful). Shows a
// gentle placeholder while the first response lands.
function HeadsUpCard({ refreshKey, firstDay }: { refreshKey: number; firstDay: number }) {
  const [card, setCard] = useState<{ headline: string; body: string } | null>(null)

  useEffect(() => {
    let alive = true
    const ws = startOfWeek(new Date(), firstDay)
    eventsApi
      .headsUp(ymd(ws), ymd(addDays(ws, 6)))
      .then((d) => alive && setCard({ headline: d.headline, body: d.body }))
      .catch(() => {})
    return () => { alive = false }
  }, [refreshKey, firstDay])

  return (
    <div className="ag-ai">
      <div className={`ag-ai-icon ${card ? '' : 'thinking'}`}><Icon name="spark" /></div>
      <div className="ed-ai-main">
        <div className="ag-ai-h">{card?.headline ?? 'Heads up this week'}</div>
        {card ? (
          <div className="ag-ai-b">{card.body}</div>
        ) : (
          <div className="ai-think" aria-label="Thinking…">
            <div className="ai-thiwf-bar" />
            <div className="ai-thiwf-bar short" />
          </div>
        )}
      </div>
    </div>
  )
}

export function AgendaView({
  events,
  tz,
  onOpenEvent,
  onPickDate,
  onCreate,
}: {
  events: AgendaEvent[]
  tz: string
  onOpenEvent: (e: AgendaEvent) => void
  onPickDate: (d: Date) => void
  onCreate: (date: string) => void
}) {
  const { persons = [] } = usePersons()
  // The agenda's week-shaped bits (heads-up window, "whose week is busy", the mini
  // month) follow the household's own week, same as the grids.
  const { household } = useHousehold()
  const firstDay = household?.weekStart === 'monday' ? 1 : 0
  // The agenda surfaces use a lighter unassigned grey than the calendar grids.
  const colorOf = useEventColor('#A6A29B')
  const today = new Date()
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const todayKey = ymd(today)

  // Group upcoming (today onward) events by local day, in chronological order. A multi-day
  // all-day event is listed under each day it covers, so a trip already under way still shows.
  const groups = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of events) {
      for (const k of eventDayKeys(e, tz)) {
        if (k >= todayKey) (map[k] ??= []).push(e)
      }
    }
    const keys = Object.keys(map).sort()
    for (const k of keys) {
      map[k].sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
        return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
      })
    }
    // Midnight (not noon) so the day-diff in dayLabel rounds to whole days —
    // otherwise today's group reads as "Tomorrow".
    return keys.map((k) => ({ key: k, date: new Date(`${k}T00:00:00`), events: map[k] }))
  }, [events, tz, todayKey])

  // "Whose week is busy?" — event counts for the household's own week, per person.
  const busy = useMemo(() => {
    const ws = startOfWeek(today, firstDay)
    const weStart = ymd(ws)
    const weEnd = ymd(addDays(ws, 6))
    const counts = new Map<string, number>()
    for (const e of events) {
      if (!eventDayKeys(e, tz).some((k) => k >= weStart && k <= weEnd)) continue
      for (const p of eventPeople(e)) if (p.id !== '_') counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
    }
    const rows = persons
      .map((p) => ({ person: p, count: counts.get(p.id) ?? 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
    const max = rows.reduce((m, r) => Math.max(m, r.count), 1)
    return { rows, max }
  }, [events, persons, tz, today, firstDay])

  return (
    <div className="ag-screen">
      <div className="ag-list">
        <div className="wf-serif ag-h">What's coming up</div>
        {/* Quick-add, matching the Day/Week bar — defaults to today. */}
        <button type="button" className="wk-add ag-add" onClick={() => onCreate(todayKey)}>
          <span className="wk-add-plus">＋</span>
          <span className="wk-add-ph">Add an event…</span>
        </button>
        {groups.length === 0 && <div className="muted" style={{ padding: '14px 4px' }}>Nothing upcoming.</div>}
        {groups.map((g) => (
          <div key={g.key} className="ag-group">
            <div className="ag-group-h">
              <span className="wf-serif">{dayLabel(g.date, todayMid)}</span>
              <span className="muted">{g.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
              {/* Add on this specific day — parity with tapping a day elsewhere. */}
              <button type="button" className="ag-group-add" title={`Add an event on ${g.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`} aria-label="Add an event on this day" onClick={() => onCreate(g.key)}><Icon name="plus" /></button>
            </div>
            {g.events.map((e) => (
              <AgendaRow key={e.id} event={e} past={isPastEvent(e, today)} color={colorOf(e)} onClick={() => onOpenEvent(e)} />
            ))}
          </div>
        ))}
      </div>

      <div className="ag-side">
        <MiniMonth events={events} tz={tz} colorOf={colorOf} onPickDate={onPickDate} firstDay={firstDay} />

        <HeadsUpCard refreshKey={events.length} firstDay={firstDay} />

        {busy.rows.length > 0 && (
          <div className="card ag-busy">
            <div className="card-h" style={{ marginBottom: 12 }}>Whose week is busy?</div>
            {busy.rows.map(({ person, count }) => {
              const color = person.colorHex ?? '#A6A29B'
              return (
                <div key={person.id} className="ag-busy-row">
                  <span className="av sm" style={{ background: `${color}22` }}>{person.avatarEmoji ?? '🙂'}</span>
                  <span className="ag-busy-name">{person.name}</span>
                  <span className="ag-busy-track">
                    <span className="ag-busy-fill" style={{ width: `${(count / busy.max) * 100}%`, background: color }} />
                  </span>
                  <span className="ag-busy-n">{count}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
