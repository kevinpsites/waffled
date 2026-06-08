import { Icon, Star } from '../icons'
import { AVATARS } from './Avatar'

// Static until chores (6.1) and lists (6.2) land. Once /api/persons is wired,
// the people here become the real family; the counts come from those domains.
const RINGS: Array<{ person: string; done: number; total: number; stars: number }> = [
  { person: 'lottie', done: 5, total: 6, stars: 24 },
  { person: 'wally', done: 9, total: 14, stars: 14 },
  { person: 'kelly', done: 2, total: 4, stars: 8 },
]

const GROCERY = ['Naan dippers', 'Cheddar, sliced', 'Ground sausage', 'Ravioli']

function Ring({ person, done, total, stars }: { person: string; done: number; total: number; stars: number }) {
  const pct = total ? done / total : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}>
      <div style={{ position: 'relative', width: 42, height: 42, flex: 'none' }}>
        <svg viewBox="0 0 42 42" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="21" cy="21" r="18" fill="none" stroke={`var(--${person}-t)`} strokeWidth="5" />
          <circle
            cx="21"
            cy="21"
            r="18"
            fill="none"
            stroke={`var(--${person})`}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(pct * 113).toFixed(0)} 113`}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 15 }}>
          {AVATARS[person]}
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, textTransform: 'capitalize' }}>{person}</div>
        <div className="tiny muted">
          {done} of {total} done
        </div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>
        <Star size={14} />
        {stars}
      </div>
    </div>
  )
}

export function FamilyColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minHeight: 0 }}>
      {/* family chores */}
      <div className="card" style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div className="card-h" style={{ fontSize: 17 }}>
            Family chores
          </div>
          <div style={{ marginLeft: 'auto' }} className="tiny muted">
            Today ›
          </div>
        </div>
        {RINGS.map((r) => (
          <Ring key={r.person} {...r} />
        ))}
      </div>

      {/* grocery */}
      <div className="card" style={{ padding: '18px 20px', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div className="card-h" style={{ fontSize: 17 }}>
            Grocery
          </div>
          <div style={{ marginLeft: 'auto' }} className="ai-tag">
            <Icon name="spark" />
            Auto
          </div>
        </div>
        {GROCERY.map((item) => (
          <div key={item} className="gitem" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
            <div
              className="gck"
              style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--hair)', flex: 'none' }}
            />
            <span style={{ fontSize: 14, fontWeight: 600 }}>{item}</span>
          </div>
        ))}
        <div className="tiny muted" style={{ paddingTop: 6, fontWeight: 600 }}>
          + 6 more from this week’s meals ›
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            marginTop: 10,
            padding: '9px 11px',
            borderRadius: 'var(--r-md)',
            border: '2px dashed var(--hair)',
            color: 'var(--ink-3)',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add item
        </div>
      </div>
    </div>
  )
}
