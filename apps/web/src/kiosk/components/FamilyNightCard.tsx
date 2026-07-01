import { useFamilyNight, familyNightApi, type FamilyNightAssignment } from '../../lib/api'

// Today card: the upcoming Family Night — its date, agenda parts, and who's on each.
// Parts default to a rotation suggestion; picking a person pins it for this week.

function fmtDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function PartRow({
  a,
  date,
  members,
}: {
  a: FamilyNightAssignment
  date: string
  members: { id: string; name: string }[]
}) {
  async function pick(personId: string) {
    await familyNightApi.saveOccurrence({ date, assignments: [{ partId: a.partId, personId: personId || null }] })
  }
  return (
    <div className="fn-row">
      <span className="fn-emoji">{a.emoji}</span>
      <div className="fn-main">
        <div className="fn-label">{a.label}</div>
        {a.suggested && a.personName && <div className="tiny muted">suggested</div>}
      </div>
      <select
        className={`fn-pick${a.suggested ? ' suggested' : ''}`}
        value={a.personId ?? ''}
        onChange={(e) => pick(e.target.value)}
        aria-label={`Who's on ${a.label}`}
      >
        <option value="">—</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
    </div>
  )
}

export function FamilyNightCard() {
  const { view, loading } = useFamilyNight()

  return (
    <div className="card fn-card" style={{ padding: '22px 22px 16px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <div className="card-h" style={{ fontSize: 23 }}>🏡 Family Night</div>
        {view && <div className="muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{fmtDate(view.next.date)}</div>}
      </div>

      {loading && <div className="muted" style={{ padding: '10px 4px' }}>Loading…</div>}

      {!loading && view && (
        <>
          {view.next.theme && <div className="fn-theme">{view.next.theme}</div>}
          {view.members.length === 0 && (
            <div className="muted" style={{ padding: '10px 4px' }}>Add family members to start rotating the agenda.</div>
          )}
          {view.next.assignments.map((a) => (
            <PartRow key={a.partId} a={a} date={view.next.date} members={view.members} />
          ))}
        </>
      )}
    </div>
  )
}
