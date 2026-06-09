import { useState } from 'react'
import { Icon } from '../icons'
import { EventModal } from './EventModal'
import { useEventsToday, type AgendaEvent } from '../../lib/api'

function formatTime(e: AgendaEvent): string {
  if (e.allDay) return 'all day'
  const d = new Date(e.startsAt)
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`
}

function AgendaRow({ event, onClick }: { event: AgendaEvent; onClick: () => void }) {
  const color = event.personColor ?? '#A6A29B'
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 4px',
        borderBottom: '1px solid var(--hair-2)',
        cursor: 'pointer',
      }}
    >
      <div style={{ width: 62, fontSize: 14, fontWeight: 700, color: 'var(--ink-2)', textAlign: 'right' }}>
        {formatTime(event)}
      </div>
      <div style={{ width: 4, height: 34, borderRadius: 99, background: color }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{event.title}</div>
        {event.location && <div className="tiny muted">{event.location}</div>}
      </div>
      <Avatars event={event} />
    </div>
  )
}

// Participant avatars (stacked); falls back to the single person for older events.
function Avatars({ event }: { event: AgendaEvent }) {
  const people =
    event.participants?.length
      ? event.participants
      : event.personEmoji
        ? [{ id: '_', name: event.personName ?? '', colorHex: event.personColor, avatarEmoji: event.personEmoji }]
        : []
  if (people.length === 0) return null
  return (
    <div style={{ display: 'flex' }}>
      {people.slice(0, 3).map((a, idx) => (
        <div
          key={a.id}
          className="av sm"
          style={{ background: `${a.colorHex ?? '#A6A29B'}22`, marginLeft: idx ? -8 : 0 }}
        >
          {a.avatarEmoji ?? '🙂'}
        </div>
      ))}
    </div>
  )
}

export function AgendaCard() {
  const { events, loading, error, refetch } = useEventsToday()
  const [selected, setSelected] = useState<AgendaEvent | null>(null)
  return (
    <div className="card" style={{ padding: '22px 22px 8px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div className="card-h nk-serif" style={{ fontSize: 23 }}>
          Today
        </div>
        <div className="muted" style={{ fontWeight: 600 }}>
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </div>
        <div style={{ marginLeft: 'auto' }} className="pill">
          <Icon name="filter" />
          <span>All</span>
        </div>
      </div>

      {loading && <div className="muted" style={{ padding: '14px 4px' }}>Loading…</div>}
      {error && <div className="muted" style={{ padding: '14px 4px' }}>Sign this kiosk in to see the calendar.</div>}
      {!loading && !error && events.length === 0 && (
        <div className="muted" style={{ padding: '14px 4px' }}>Nothing on the calendar today.</div>
      )}
      {events.map((e) => (
        <AgendaRow key={e.id} event={e} onClick={() => setSelected(e)} />
      ))}
      {selected && <EventModal event={selected} onClose={() => setSelected(null)} onSaved={refetch} />}
    </div>
  )
}
