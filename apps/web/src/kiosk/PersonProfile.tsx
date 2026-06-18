import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTopbarFull } from './topbar-slot'
import { usePersonOverview, useConversions, usePersons, personsApi, rewardsApi, type OverviewGoal, type CategoryBalance, type ShopReward, type SavingToward, type OverviewCurrency, type StreakSummary } from '../lib/api'
import { TradeModal } from './components/TradeModal'
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

function GoalRow({ g, onOpen }: { g: OverviewGoal; onOpen: () => void }) {
  const pct = g.pct ?? 0
  return (
    <button type="button" className="pp-goal" onClick={onOpen} title={`Open ${g.title}`}>
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
        <b>{+g.progress.toFixed(g.progress % 1 ? 1 : 0)}</b>
        <span className="muted">
          /{g.target ?? '—'}
          {g.goalType === 'habit'
            ? ` ${g.habitPeriod === 'day' ? 'today' : g.habitPeriod === 'month' ? 'this month' : 'this week'}`
            : g.goalType === 'checklist'
              ? ' steps'
              : g.unit ? ` ${g.unit}` : ''}
        </span>
      </div>
    </button>
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

// A jar that fills from the bottom to `pct` — the Goal-jar take on "saving toward".
function Jar({ pct, color }: { pct: number; color: string }) {
  const f = Math.max(0, Math.min(100, pct))
  const fillTop = 14 + 78 * (1 - f / 100)
  return (
    <svg viewBox="0 0 80 100" width="72" height="90" aria-hidden>
      <defs>
        <clipPath id="jarclip"><rect x="14" y="14" width="52" height="78" rx="11" /></clipPath>
      </defs>
      <rect x="24" y="3" width="32" height="8" rx="2.5" fill="#cdbb9c" />
      <rect x="14" y="14" width="52" height="78" rx="11" fill="#fff" stroke="#e0d4c2" strokeWidth="3" />
      <rect x="14" y={fillTop} width="52" height={92 - fillTop} fill={color} opacity="0.85" clipPath="url(#jarclip)" />
      <text x="40" y="60" textAnchor="middle" fontSize="17" fontWeight="800" fill={f > 55 ? '#fff' : 'var(--ink)'}>{Math.round(f)}%</text>
    </svg>
  )
}

// Weekly fire row + consecutive-day count — chores and goals both keep it alive.
function StreakCard({ streak }: { streak: StreakSummary }) {
  return (
    <div className="card pp-card pp-streak">
      <div className="pp-streak-head">
        <span className="pp-streak-days">🔥 {streak.days}-day streak</span>
        <span className="pp-streak-cheer">{streak.days >= 2 ? 'Keep it up!' : 'Start one today'}</span>
      </div>
      <div className="pp-streak-week">
        {streak.week.map((d, i) => (
          <div key={i} className={`pp-streak-day ${d.active ? 'on' : ''} ${d.isToday ? 'today' : ''} ${d.isFuture ? 'future' : ''}`}>
            <span className="pp-streak-icon">{d.active ? '🔥' : '·'}</span>
            <span className="pp-streak-label">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// The single "Saving toward" hub: progress for the pinned reward (bar or jar),
// or — when nothing is pinned, or on Change — a compact selector over the whole
// shop (scales better than a grid when there are many rewards).
function SavingTowardCard({ saving, shop, cur, onPick, onRedeem }: {
  saving: SavingToward | null
  shop: ShopReward[]
  cur: (key: string) => OverviewCurrency | undefined
  onPick: (rewardId: string | null) => void
  onRedeem: (r: SavingToward) => void
}) {
  const [jar, setJar] = useState(false)
  const [picking, setPicking] = useState(false)
  const showProgress = saving && !picking

  return (
    <div className="card pp-card pp-saving">
      <div className="card-h" style={{ marginBottom: 10, display: 'flex', alignItems: 'center' }}>
        <span>Saving toward</span>
        {showProgress && (
          <div className="seg pp-saving-toggle" style={{ marginLeft: 'auto' }}>
            <button type="button" className={jar ? '' : 'on'} onClick={() => setJar(false)}>Bar</button>
            <button type="button" className={jar ? 'on' : ''} onClick={() => setJar(true)}>Jar</button>
          </div>
        )}
      </div>

      {showProgress ? (
        (() => {
          const s = saving!
          const c = cur(s.currency)
          const color = c?.color ?? 'var(--wally)'
          return (
            <div className="pp-saving-row">
              {jar && <Jar pct={s.pct} color={color} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="pp-saving-title">{s.emoji ?? '🎁'} {s.title}</div>
                {!jar && <div className="pp-saving-bar"><span style={{ width: `${s.pct}%`, background: color }} /></div>}
                <div className="pp-saving-sub">
                  {s.toGo === 0
                    ? <b style={{ color }}>Ready to redeem! 🎉</b>
                    : <><b>{s.have}</b> of {s.cost} {c?.symbol ?? '⭐'} · <b style={{ color }}>{s.toGo} to go</b></>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {s.toGo === 0 && <button type="button" className="pp-shop-redeem" style={{ width: 'auto' }} onClick={() => onRedeem(s)}>Redeem</button>}
                <button type="button" className="pp-trade" onClick={() => setPicking(true)}>Change</button>
              </div>
            </div>
          )
        })()
      ) : shop.length === 0 ? (
        <div className="muted tiny" style={{ fontWeight: 600 }}>No rewards yet — a parent can add some in Tasks → Rewards.</div>
      ) : (
        <div className="pp-saving-pick">
          <select
            className="pp-saving-select"
            defaultValue={saving?.id ?? ''}
            onChange={(e) => { if (e.target.value) { onPick(e.target.value); setPicking(false) } }}
          >
            <option value="" disabled>Choose a reward to save toward…</option>
            {shop.map((r) => {
              const sym = cur(r.currency)?.symbol ?? '⭐'
              return <option key={r.id} value={r.id}>{r.emoji ?? '🎁'} {r.title} — {r.cost} {sym}{r.toGo === 0 ? ' (ready!)' : ` (${r.toGo} to go)`}</option>
            })}
          </select>
          {saving && <button type="button" className="pp-trade" onClick={() => setPicking(false)}>Cancel</button>}
        </div>
      )}
    </div>
  )
}

export function PersonProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error } = usePersonOverview(id ?? null)
  const { conversions } = useConversions()
  const { persons } = usePersons()
  const [trading, setTrading] = useState(false)

  // Segment switcher: jump straight between family members (and back to the
  // Family grid via "Everyone") without bouncing through a Back button.
  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 12, minWidth: 0 }}>
        <button className="pill" style={{ cursor: 'pointer', flex: 'none' }} onClick={() => navigate('/family')}>‹ Family</button>
        <div className="seg pp-switch" style={{ minWidth: 0, overflowX: 'auto' }}>
          <button className="" style={{ cursor: 'pointer' }} onClick={() => navigate('/family')}>Everyone</button>
          {persons.map((p) => (
            <button
              key={p.id}
              className={p.id === id ? 'on' : ''}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/person/${p.id}`)}
            >
              {p.name.split(' ')[0]}
            </button>
          ))}
        </div>
        <button className="pill btn-primary" style={{ color: '#fff', border: 0, marginLeft: 'auto', flex: 'none', cursor: 'pointer' }} onClick={() => navigate('/goals/new')}>
          ＋ New goal{data?.person.name ? ` for ${data.person.name}` : ''}
        </button>
      </div>
    ),
    [navigate, data?.person.name, persons, id]
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
                    <span key={s}>{i > 0 ? ' or ' : ''}<button className="pp-suggest" onClick={() => navigate(`/goals/new?title=${encodeURIComponent(s)}`)}>“{s}”</button></span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card pp-card">
          <div className="card-h" style={{ marginBottom: 10 }}>{person.name}’s goals</div>
          {data.goals.length === 0 && <div className="muted tiny" style={{ fontWeight: 600 }}>No goals yet.</div>}
          {data.goals.map((g) => <GoalRow key={g.id} g={g} onOpen={() => navigate(`/goals/${g.id}`)} />)}
        </div>
      </div>

      <div className="pp-right">
        <StreakCard streak={data.streak} />

        <SavingTowardCard
          saving={data.savingToward}
          shop={data.rewardShop}
          cur={symOf}
          onPick={(rid) => personsApi.setSavingToward(person.id, rid)}
          onRedeem={(r) => rewardsApi.redeem(r.id, person.id)}
        />

        <div className="card pp-card pp-stars">
          <div className="card-h" style={{ marginBottom: 4, display: 'flex', alignItems: 'center' }}>
            <span>{defaultCur?.label ?? 'Stars'} & chores</span>
            {conversions.length > 0 && (
              <button type="button" className="pp-trade" style={{ marginLeft: 'auto' }} onClick={() => setTrading(true)}>⇄ Trade</button>
            )}
          </div>
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
              <span className="pp-ledger-r">{e.detail ?? reasonLabel(e.reason)}</span>
            </div>
          ))}
        </div>

        <div className="card pp-card">
          <div className="card-h" style={{ marginBottom: 10, display: 'flex', alignItems: 'center' }}>
            <span>Reward redemptions</span>
            <button type="button" className="pp-trade" style={{ marginLeft: 'auto' }} onClick={() => navigate('/tasks?tab=rewards')}>🎁 Shop</button>
          </div>
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

      {trading && (
        <TradeModal
          person={{ id: person.id, name: person.name }}
          balances={data.balances}
          conversions={conversions}
          onClose={() => setTrading(false)}
        />
      )}
    </div>
  )
}
