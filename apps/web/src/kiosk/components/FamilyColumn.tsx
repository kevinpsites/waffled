import { usePersons, type Person } from '../../lib/api'
import { GroceryCard } from './GroceryCard'

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

export function FamilyColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minHeight: 0 }}>
      <FamilyCard />
      <GroceryCard />
    </div>
  )
}
