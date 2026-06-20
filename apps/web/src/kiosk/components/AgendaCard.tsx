import { useState } from 'react'
import { Icon } from '../icons'
import { EventModal } from './EventModal'
import { eventPeople } from './cal-utils'
import { useEventsToday, usePersons, type AgendaEvent } from '../../lib/api'

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

// When the day is light (≤3 events), show roomier square-ish cards instead of
// tight rows so the calendar doesn't look sparse.
function AgendaBigCard({ event, onClick }: { event: AgendaEvent; onClick: () => void }) {
  const color = event.personColor ?? '#A6A29B'
  return (
    <div className="agenda-bigcard" onClick={onClick} role="button" tabIndex={0} style={{ borderTop: `3px solid ${color}` }}>
      <div className="ab-time" style={{ color }}>{formatTime(event)}</div>
      <div className="ab-title">{event.title}</div>
      {event.location && <div className="tiny muted ab-loc">📍 {event.location}</div>}
      <div className="ab-foot">
        <Avatars event={event} />
      </div>
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
  const { persons = [] } = usePersons()
  const [selected, setSelected] = useState<AgendaEvent | null>(null)
  // Today's events can be filtered to one person (owner or participant). null = all.
  const [filterId, setFilterId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const shown = filterId
    ? events.filter((e) => e.personId === filterId || eventPeople(e).some((p) => p.id === filterId))
    : events
  const activePerson = persons.find((p) => p.id === filterId)

  return (
    <div className="card" style={{ padding: '22px 22px 8px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div className="card-h" style={{ fontSize: 23 }}>
          Today
        </div>
        <div className="muted" style={{ fontWeight: 600 }}>
          {shown.length} {shown.length === 1 ? 'event' : 'events'}
        </div>
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button type="button" className="pill" onClick={() => setMenuOpen((o) => !o)} style={{ cursor: 'pointer' }}>
            <Icon name="filter" />
            <span>{activePerson ? activePerson.name : 'All'}</span>
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div className="agenda-filter-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, background: 'var(--card)', border: '1px solid var(--hair)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-2)', padding: 6, minWidth: 160 }}>
                <FilterOption label="Everyone" on={!filterId} onClick={() => { setFilterId(null); setMenuOpen(false) }} />
                {persons.map((p) => (
                  <FilterOption
                    key={p.id}
                    label={p.name}
                    emoji={p.avatarEmoji ?? '🙂'}
                    color={p.colorHex ?? '#A6A29B'}
                    on={filterId === p.id}
                    onClick={() => { setFilterId(p.id); setMenuOpen(false) }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {loading && <div className="muted" style={{ padding: '14px 4px' }}>Loading…</div>}
      {error && <div className="muted" style={{ padding: '14px 4px' }}>Sign this kiosk in to see the calendar.</div>}
      {!loading && !error && shown.length === 0 && (
        <div className="muted" style={{ padding: '14px 4px' }}>
          {filterId ? `Nothing on ${activePerson?.name ?? 'their'} calendar today.` : 'Nothing on the calendar today.'}
        </div>
      )}
      {!loading && !error && shown.length > 0 && shown.length <= 3 ? (
        <div className="agenda-biggrid">
          {shown.map((e) => (
            <AgendaBigCard key={e.id} event={e} onClick={() => setSelected(e)} />
          ))}
        </div>
      ) : (
        shown.map((e) => <AgendaRow key={e.id} event={e} onClick={() => setSelected(e)} />)
      )}
      {selected && <EventModal event={selected} onClose={() => setSelected(null)} onSaved={refetch} />}
    </div>
  )
}

// One row in the Today filter dropdown.
function FilterOption({ label, emoji, color, on, onClick }: { label: string; emoji?: string; color?: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
        padding: '8px 10px', borderRadius: 8, border: 0, cursor: 'pointer', font: 'inherit', fontSize: 14, fontWeight: 600,
        background: on ? 'var(--panel)' : 'transparent', color: 'var(--ink)',
      }}
    >
      {emoji ? (
        <span className="av sm" style={{ background: `${color ?? '#A6A29B'}22` }}>{emoji}</span>
      ) : (
        <span style={{ width: 26, textAlign: 'center' }}>👥</span>
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {on && <span style={{ color: 'var(--primary)', fontWeight: 800 }}>✓</span>}
    </button>
  )
}
