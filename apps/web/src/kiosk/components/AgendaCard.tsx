import { Icon } from '../icons'
import { Avatar } from './Avatar'

// Static until the calendar domain (M5) lands.
const AGENDA: Array<{ time: string; person: string; title: string }> = [
  { time: '8:30', person: 'wally', title: 'Swim lessons' },
  { time: '1:30', person: 'kevin', title: 'Psychiatrist appt' },
  { time: '5:30', person: 'kelly', title: 'Tele-health call' },
  { time: 'all day', person: 'lottie', title: 'Dance recital tickets' },
]

export function AgendaCard() {
  return (
    <div className="card" style={{ padding: '22px 22px 8px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div className="card-h nk-serif" style={{ fontSize: 23 }}>
          Today
        </div>
        <div className="muted" style={{ fontWeight: 600 }}>
          {AGENDA.length} events
        </div>
        <div style={{ marginLeft: 'auto' }} className="pill">
          <Icon name="filter" />
          <span>All</span>
        </div>
      </div>

      {AGENDA.map((ev) => (
        <div
          key={`${ev.time}-${ev.title}`}
          className={`home-ev ${ev.person}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '13px 4px',
            borderBottom: '1px solid var(--hair-2)',
          }}
        >
          <div style={{ width: 62, fontSize: 14, fontWeight: 700, color: 'var(--ink-2)', textAlign: 'right' }}>
            {ev.time}
          </div>
          <div style={{ width: 4, height: 34, borderRadius: 99, background: `var(--${ev.person})` }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{ev.title}</div>
          </div>
          <Avatar person={ev.person} size="sm" />
        </div>
      ))}

      <div
        style={{
          marginTop: 'auto',
          padding: '14px 4px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--ink-3)',
        }}
      >
        <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Tomorrow · Chorizo Tacos night · 2 events</span>
      </div>
    </div>
  )
}
