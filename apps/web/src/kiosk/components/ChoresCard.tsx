import { Link } from 'react-router-dom'
import { Star } from '../icons'
import { useChoresToday, type PersonChores } from '../../lib/api'

// Per-person progress ring, colored by the member's own color.
function Ring({ person }: { person: PersonChores }) {
  const pct = person.total ? person.done / person.total : 0
  const color = person.colorHex ?? '#6B6B70'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}>
      <div style={{ position: 'relative', width: 42, height: 42, flex: 'none' }}>
        <svg viewBox="0 0 42 42" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="21" cy="21" r="18" fill="none" stroke={`${color}33`} strokeWidth="5" />
          <circle
            cx="21"
            cy="21"
            r="18"
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(pct * 113).toFixed(0)} 113`}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 15 }}>
          {person.avatarEmoji ?? '🙂'}
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{person.name}</div>
        <div className="tiny muted">
          {person.done} of {person.total} done
        </div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>
        <Star size={14} />
        {person.stars}
      </div>
    </div>
  )
}

export function ChoresCard() {
  const { people, loading, error } = useChoresToday()
  const withChores = people.filter((p) => p.total > 0)
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <div className="card-h" style={{ fontSize: 17 }}>
          Family chores
        </div>
        <Link to="/tasks" className="tiny muted" style={{ marginLeft: 'auto', textDecoration: 'none', color: 'var(--ink-2)' }}>
          Today ›
        </Link>
      </div>
      {loading && <div className="tiny muted" style={{ padding: '8px 0' }}>Loading…</div>}
      {error && (
        <div className="tiny muted" style={{ padding: '8px 0' }}>Sign this kiosk in to see chores.</div>
      )}
      {!loading && !error && withChores.length === 0 && (
        <div className="tiny muted" style={{ padding: '8px 0' }}>No chores yet.</div>
      )}
      {withChores.map((p) => (
        <Ring key={p.id} person={p} />
      ))}
    </div>
  )
}
