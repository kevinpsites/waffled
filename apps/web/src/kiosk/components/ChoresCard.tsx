import { Link } from 'react-router'
import { useChoresToday, useCurrencies, type PersonChores } from '../../lib/api'

// Per-person progress ring, colored by the member's own color. `sym` is the
// household default currency symbol (renders ⭐ / 💵 / etc. from the catalog).
// The whole row links through to the full Chores page so a tap on a person
// goes somewhere (feedback: it read as clickable but had no link).
function Ring({ person, sym }: { person: PersonChores; sym: string }) {
  const pct = person.total ? person.done / person.total : 0
  const color = person.colorHex ?? '#6B6B70'
  return (
    <Link
      to="/tasks"
      className="chores-card-row"
      style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}
    >
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
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>
        <span style={{ fontSize: 14 }}>{sym}</span>
        {person.stars}
      </div>
    </Link>
  )
}

export function ChoresCard() {
  const { people, loading, error } = useChoresToday()
  const { defaultCurrency } = useCurrencies()
  const sym = defaultCurrency?.symbol ?? '⭐'
  const withChores = people.filter((p) => p.total > 0)
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <div className="card-h" style={{ fontSize: 17 }}>
          Family Chores
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
        <Ring key={p.id} person={p} sym={sym} />
      ))}
    </div>
  )
}
