import { Icon } from '../icons'
import { usePersons, type Person } from '../../lib/api'

// Real family avatar — tinted with the member's own color.
function PersonAvatar({ person }: { person: Person }) {
  const color = person.colorHex ?? '#6B6B70'
  return (
    <div className="av md" style={{ background: `${color}22` }}>
      {person.avatarEmoji ?? '🙂'}
    </div>
  )
}

function MemberRow({ person }: { person: Person }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}>
      <PersonAvatar person={person} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{person.name}</div>
        <div className="tiny muted" style={{ textTransform: 'capitalize' }}>
          {person.memberType}
          {person.isAdmin ? ' · Admin' : ''}
        </div>
      </div>
    </div>
  )
}

// The real family, from /api/persons. (When chores land this becomes per-person
// progress; for now it's the actual household roster.)
function FamilyCard() {
  const { persons, loading, error } = usePersons()
  return (
    <div className="card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <div className="card-h" style={{ fontSize: 17 }}>
          Family
        </div>
        {persons.length > 0 && (
          <div style={{ marginLeft: 'auto' }} className="tiny muted">
            {persons.length} {persons.length === 1 ? 'member' : 'members'}
          </div>
        )}
      </div>
      {loading && <div className="tiny muted" style={{ padding: '8px 0' }}>Loading…</div>}
      {error && (
        <div className="tiny muted" style={{ padding: '8px 0' }}>
          Sign this kiosk in to see your family.
        </div>
      )}
      {!loading && !error && persons.length === 0 && (
        <div className="tiny muted" style={{ padding: '8px 0' }}>No family members yet.</div>
      )}
      {persons.map((p) => (
        <MemberRow key={p.id} person={p} />
      ))}
    </div>
  )
}

// Static until the lists domain (6.2) lands.
const GROCERY = ['Naan dippers', 'Cheddar, sliced', 'Ground sausage', 'Ravioli']

function GroceryCard() {
  return (
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
        <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
          <div style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--hair)', flex: 'none' }} />
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
  )
}

export function FamilyColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minHeight: 0 }}>
      <FamilyCard />
      <GroceryCard />
    </div>
  )
}
