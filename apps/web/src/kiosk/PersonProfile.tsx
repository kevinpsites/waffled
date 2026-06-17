import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { usePersonOverview, type OverviewGoal, type CategoryBalance } from '../lib/api'
import './../styles/overview.css'

const CAT_CLASS: Record<string, string> = {
  physical: 'cat-physical', intellectual: 'cat-intellectual', spiritual: 'cat-spiritual', creative: 'cat-creative', social: 'cat-social',
}

function reasonLabel(reason: string): string {
  if (reason === 'chore_completed') return 'Chore done'
  if (reason === 'chore_uncompleted') return 'Chore undone'
  if (reason === 'reward_redeemed') return 'Reward'
  return reason.replace(/_/g, ' ')
}

function GoalRow({ g }: { g: OverviewGoal }) {
  const pct = g.pct ?? 0
  return (
    <div className="pp-goal">
      <span className="pp-goal-emo">{g.emoji ?? '🎯'}</span>
      <div className="pp-goal-body">
        <div className="pp-goal-top">
          <span className="pp-goal-title">{g.title}</span>
          {g.category && <span className={`pp-cat-chip ${CAT_CLASS[g.category] ?? ''}`}>{g.category}</span>}
          {g.streakDays >= 2 && <span className="pp-goal-streak">🔥 {g.streakDays}</span>}
        </div>
        <div className="pp-goal-bar"><span style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="pp-goal-num">
        <b>{g.goalType === 'checklist' ? g.milestoneReached : +g.progress.toFixed(g.progress % 1 ? 1 : 0)}</b>
        <span className="muted">/{g.goalType === 'checklist' ? g.milestoneTotal : g.target ?? '—'}{g.unit ? ` ${g.unit}` : ''}</span>
      </div>
    </div>
  )
}

function BalanceTile({ c }: { c: CategoryBalance }) {
  const r = 26
  const circ = 2 * Math.PI * r
  return (
    <div className={`pp-bal ${c.goalCount === 0 ? 'empty' : ''}`} title={`${c.label}: ${c.goalCount} goal${c.goalCount === 1 ? '' : 's'}, ${c.avgPct}% avg`}>
      <svg viewBox="0 0 64 64" className="pp-bal-ring">
        <circle cx="32" cy="32" r={r} className="pp-bal-track" />
        <circle cx="32" cy="32" r={r} className={`pp-bal-fill ${CAT_CLASS[c.category]}`}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - c.avgPct / 100)} transform="rotate(-90 32 32)" />
        <text x="32" y="37" textAnchor="middle" className="pp-bal-emo">{c.emoji}</text>
      </svg>
      <div className="pp-bal-label">{c.label}</div>
      <div className="pp-bal-count">{c.goalCount === 0 ? 'none yet' : `${c.goalCount} goal${c.goalCount === 1 ? '' : 's'}`}</div>
    </div>
  )
}

export function PersonProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error } = usePersonOverview(id ?? null)

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={() => navigate(-1)}>‹ Back</button>
        <div className="nk-serif" style={{ fontSize: 18, fontWeight: 600 }}>{data?.person.name ?? 'Profile'}</div>
        <button className="pill btn-primary" style={{ color: '#fff', border: 0, marginLeft: 'auto', cursor: 'pointer' }} onClick={() => navigate('/goals/new')}>
          ＋ New goal{data?.person.name ? ` for ${data.person.name}` : ''}
        </button>
      </div>
    ),
    [navigate, data?.person.name]
  )

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !data) return <div className="muted" style={{ padding: 30 }}>Couldn’t load this profile.</div>

  const { person, insight } = data
  const defaultCur = data.currencies.find((c) => c.isDefault) ?? data.currencies[0]
  const symOf = (key: string) => data.currencies.find((c) => c.key === key)
  const subBits = [
    person.age != null ? `Age ${person.age}` : null,
    `${data.activeGoals} active goal${data.activeGoals === 1 ? '' : 's'}`,
    data.topStreak >= 2 ? `🔥 ${data.topStreak}-day streak` : null,
    `${defaultCur?.symbol ?? '⭐'} ${data.stars} ${(defaultCur?.label ?? 'stars').toLowerCase()}`,
  ].filter(Boolean)

  return (
    <div className="person-profile">
      <div className="pp-left">
        <div className="pp-hero">
          <span className="pp-av" style={{ background: person.colorHex ? `${person.colorHex}22` : 'var(--panel)' }}>{person.avatarEmoji ?? '🙂'}</span>
          <div>
            <div className="nk-serif pp-name">{person.name}</div>
            <div className="pp-sub">{subBits.join(' · ')}</div>
          </div>
        </div>

        <div className="card pp-card">
          <div className="card-h" style={{ marginBottom: 12 }}>Whole-person balance</div>
          <div className="pp-balances">
            {data.categoryBalance.map((c) => <BalanceTile key={c.category} c={c} />)}
          </div>
          <div className="pp-insight">
            <div className="ai-spark" aria-hidden><span>✦</span></div>
            <div>
              <div className="pp-insight-t">{insight.text}</div>
              {insight.suggestions.length > 0 && (
                <div className="pp-insight-s">
                  A gentle idea:{' '}
                  {insight.suggestions.map((s, i) => (
                    <span key={s}>{i > 0 ? ' or ' : ''}<button className="pp-suggest" onClick={() => navigate('/goals/new')}>“{s}”</button></span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card pp-card">
          <div className="card-h" style={{ marginBottom: 10 }}>{person.name}’s goals</div>
          {data.goals.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No goals yet.</div>}
          {data.goals.map((g) => <GoalRow key={g.id} g={g} />)}
        </div>
      </div>

      <div className="pp-right">
        <div className="card pp-card pp-stars">
          <div className="card-h" style={{ marginBottom: 4 }}>{defaultCur?.label ?? 'Stars'} & chores</div>
          <div className="pp-star-big" style={defaultCur?.color ? { color: defaultCur.color } : undefined}>{defaultCur?.symbol ?? '⭐'} {data.stars}</div>
          {data.currencies.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
              {data.balances.filter((b) => b.currency !== defaultCur?.key).map((b) => {
                const c = symOf(b.currency)
                return <span key={b.currency} style={{ fontWeight: 800, fontSize: 14, color: c?.color ?? 'var(--ink-2)' }}>{c?.symbol ?? ''} {b.balance}</span>
              })}
            </div>
          )}
          <div className="tiny muted" style={{ fontWeight: 700, margin: '12px 0 4px' }}>RECENT</div>
          {data.recentLedger.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No activity yet.</div>}
          {data.recentLedger.map((e, i) => (
            <div key={i} className="pp-ledger">
              <span className={`pp-ledger-amt ${e.amount >= 0 ? 'pos' : 'neg'}`}>{e.amount >= 0 ? `+${e.amount}` : e.amount} {symOf(e.currency)?.symbol ?? ''}</span>
              <span className="pp-ledger-r">{reasonLabel(e.reason)}</span>
            </div>
          ))}
        </div>

        <div className="card pp-card">
          <div className="card-h" style={{ marginBottom: 10 }}>Reward redemptions</div>
          {data.redemptions.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>None yet — earn {(defaultCur?.label ?? 'stars').toLowerCase()}, then redeem in Tasks → Rewards.</div>}
          {data.redemptions.map((r) => (
            <div key={r.id} className="pp-redeem">
              <span className="pp-redeem-emo">{r.emoji ?? '🎁'}</span>
              <span className="pp-redeem-t">{r.title}</span>
              <span className={`pp-redeem-status st-${r.status}`}>{r.status}</span>
              <span className="pp-redeem-cost">{symOf(r.currency)?.symbol ?? '⭐'} {r.cost}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
