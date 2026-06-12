import { useNavigate } from 'react-router'
import { useTopbarRight } from './topbar-slot'
import { useFamilyOverview, type FamilyMember } from '../lib/api'
import './../styles/overview.css'

function MemberCard({ m, onOpen }: { m: FamilyMember; onOpen: () => void }) {
  return (
    <button type="button" className="card fam-card" onClick={onOpen}>
      <div className="fam-head">
        <span className="fam-av" style={{ background: m.colorHex ? `${m.colorHex}22` : 'var(--panel)' }}>{m.avatarEmoji ?? '🙂'}</span>
        <div className="fam-name-wrap">
          <div className="fam-name">{m.name}</div>
          {m.age != null && <div className="tiny muted" style={{ fontWeight: 600 }}>Age {m.age}</div>}
        </div>
        {m.topStreak >= 2 && <span className="fam-streak">🔥 {m.topStreak}</span>}
      </div>
      <div className="fam-stats">
        <div className="fam-stat">
          <div className="fam-stat-n">{m.activeGoals}</div>
          <div className="fam-stat-l">goals</div>
        </div>
        <div className="fam-stat">
          <div className="fam-stat-n">{m.avgProgressPct}%</div>
          <div className="fam-stat-l">avg progress</div>
        </div>
        <div className="fam-stat">
          <div className="fam-stat-n" style={{ color: 'var(--lottie)' }}>⭐ {m.stars}</div>
          <div className="fam-stat-l">stars</div>
        </div>
      </div>
      <div className="fam-bar"><span style={{ width: `${m.avgProgressPct}%` }} /></div>
    </button>
  )
}

export function FamilyOverview() {
  const navigate = useNavigate()
  const { people, loading, error } = useFamilyOverview()

  useTopbarRight(
    () => (
      <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate('/goals')}>🎯 Goals</button>
    ),
    [navigate]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error) return <div className="muted" style={{ padding: 30 }}>Couldn’t load the family overview.</div>

  return (
    <div className="family-overview">
      <div className="fam-title nk-serif">How everyone’s doing</div>
      <div className="fam-grid">
        {people.map((m) => (
          <MemberCard key={m.personId} m={m} onOpen={() => navigate(`/person/${m.personId}`)} />
        ))}
      </div>
    </div>
  )
}
