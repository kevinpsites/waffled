import { useState } from 'react'
import { useNavigate } from 'react-router'
import { rewardsApi, useRewardsHub, type Reward, type Currency } from '../../lib/api'

function Avatar({ emoji, color, name }: { emoji: string | null; color: string | null; name: string | null }) {
  return (
    <span className="rw-av" style={{ background: color ? `${color}22` : 'var(--panel)' }} title={name ?? ''}>
      {emoji ?? '🙂'}
    </span>
  )
}

// A balance/cost rendered with its currency's symbol + color (falls back to ⭐).
function Coin({ currency, amount }: { currency: Currency | undefined; amount: number }) {
  return (
    <span className="rw-coin" style={currency?.color ? { color: currency.color } : undefined}>
      <span className="rw-coin-sym">{currency?.symbol ?? '⭐'}</span> {amount}
    </span>
  )
}

// The "spend" side of the economy: per-kid balances (per currency), a parent-
// approval queue, and a rewards catalog kids redeem against. Currencies come from
// the household catalog (Settings → Stars & currencies); a one-currency family
// just sees one balance, a tiered family sees several.
export function RewardsPanel() {
  const { rewards, balances, currencies, pending, loading, error, refetch } = useRewardsHub()
  const navigate = useNavigate()
  const [redeemFor, setRedeemFor] = useState<Reward | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const curOf = (key: string) => currencies.find((c) => c.key === key)
  const balanceOf = (personId: string, key: string) =>
    balances.find((b) => b.personId === personId)?.balances.find((x) => x.currency === key)?.balance ?? 0

  async function redeem(reward: Reward, personId: string) {
    setBusy(reward.id)
    try {
      await rewardsApi.redeem(reward.id, personId)
      setRedeemFor(null)
      refetch()
    } finally {
      setBusy(null)
    }
  }
  async function decide(id: string, approve: boolean) {
    setBusy(id)
    try {
      await (approve ? rewardsApi.approve(id) : rewardsApi.deny(id))
      refetch()
    } catch {
      refetch()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="muted" style={{ padding: 20 }}>Loading…</div>
  if (error) return <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see rewards.</div>

  return (
    <div className="rewards-panel">
      {/* balances — tap a kid to see how they've earned & spent */}
      <div className="rw-balances">
        {balances.map((b) => (
          <button key={b.personId} type="button" className="rw-bal" onClick={() => navigate(`/person/${b.personId}`)} title={`${b.name}’s history`}>
            <Avatar emoji={b.avatarEmoji} color={b.colorHex} name={b.name} />
            <div className="rw-bal-meta">
              <div className="rw-bal-name">{b.name}</div>
              <div className="rw-bal-coins">
                {b.balances.map((cb) => <Coin key={cb.currency} currency={curOf(cb.currency)} amount={cb.balance} />)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* approvals */}
      {pending.length > 0 && (
        <div className="card rw-approvals">
          <div className="card-h" style={{ marginBottom: 10 }}>Needs your OK</div>
          {pending.map((p) => (
            <div key={p.id} className="rw-appr">
              <Avatar emoji={p.personAvatar} color={p.personColor} name={p.personName} />
              <div className="rw-appr-txt">
                <span className="rw-appr-name">{p.personName}</span> wants{' '}
                <span className="rw-appr-reward">{p.emoji ? `${p.emoji} ` : ''}{p.title}</span>
                <span className="rw-appr-cost"><Coin currency={curOf(p.currency)} amount={p.cost} /></span>
              </div>
              <div className="rw-appr-actions">
                <button type="button" className="pill" disabled={busy === p.id} onClick={() => decide(p.id, false)}>Deny</button>
                <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy === p.id} onClick={() => decide(p.id, true)}>Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* catalog */}
      <div className="rw-cat-head">
        <div className="card-h">Rewards</div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setAdding(true)}>＋ Add reward</button>
      </div>
      {rewards.length === 0 ? (
        <div className="rw-empty">
          <div className="rw-empty-emo">🎁</div>
          <div className="rw-empty-h">No rewards yet</div>
          <div className="rw-empty-b">Add something the kids can save up for — movie night, extra screen time, a trip to the park.</div>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={() => setAdding(true)}>
            ＋ Add a reward
          </button>
        </div>
      ) : (
        <div className="rw-grid">
          {rewards.map((r) => (
            <div key={r.id} className="rw-card">
              <button type="button" className="rw-del" aria-label={`Remove ${r.title}`} onClick={() => rewardsApi.deleteReward(r.id).then(refetch)}>×</button>
              <div className="rw-card-emo">{r.emoji ?? '🎁'}</div>
              <div className="rw-card-title">{r.title}</div>
              <div className="rw-card-cost"><Coin currency={curOf(r.currency)} amount={r.cost} /></div>
              {redeemFor?.id === r.id ? (
                <div className="rw-pick">
                  {balances.map((b) => {
                    const bal = balanceOf(b.personId, r.currency)
                    return (
                      <button
                        key={b.personId}
                        type="button"
                        className="rw-pick-p"
                        disabled={busy === r.id || bal < r.cost}
                        title={bal < r.cost ? `${b.name} needs ${r.cost - bal} more` : `Redeem for ${b.name}`}
                        onClick={() => redeem(r, b.personId)}
                      >
                        {b.avatarEmoji ?? '🙂'}
                      </button>
                    )
                  })}
                  <button type="button" className="rw-pick-x" onClick={() => setRedeemFor(null)}>×</button>
                </div>
              ) : (
                <button type="button" className="rw-redeem" onClick={() => setRedeemFor(r)}>Redeem</button>
              )}
            </div>
          ))}
        </div>
      )}

      {adding && <AddRewardModal currencies={currencies} onClose={() => setAdding(false)} onSaved={refetch} />}
    </div>
  )
}

function AddRewardModal({ currencies, onClose, onSaved }: { currencies: Currency[]; onClose: () => void; onSaved: () => void }) {
  const spendable = currencies.filter((c) => c.spendable)
  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('🎁')
  const [cost, setCost] = useState(10)
  const [currencyKey, setCurrencyKey] = useState(() => (spendable.find((c) => c.isDefault) ?? spendable[0])?.key ?? 'stars')
  const [saving, setSaving] = useState(false)
  const selected = spendable.find((c) => c.key === currencyKey)
  async function save() {
    if (!title.trim()) return
    setSaving(true)
    try {
      await rewardsApi.createReward({ title: title.trim(), emoji: emoji.trim() || null, cost, currency: currencyKey })
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Add a reward</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <input className="rw-emoji-in" value={emoji} onChange={(e) => setEmoji(e.target.value)} aria-label="Emoji" maxLength={2} />
          <input className="rw-title-in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Movie night, 30 min screen time…" aria-label="Reward title" autoFocus />
        </div>
        {/* currency picker — only when the family has more than one spendable currency */}
        {spendable.length > 1 && (
          <div className="rw-cur-pick">
            {spendable.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`rw-cur-chip ${c.key === currencyKey ? 'on' : ''}`}
                style={c.key === currencyKey && c.color ? { borderColor: c.color, color: c.color, background: `${c.color}18` } : undefined}
                onClick={() => setCurrencyKey(c.key)}
              >
                {c.symbol ?? '⭐'} {c.label}
              </button>
            ))}
          </div>
        )}
        <label className="rw-cost-field">
          <span>Cost</span>
          <div className="rw-cost-stepper">
            <button type="button" onClick={() => setCost((c) => Math.max(0, c - 5))}>−</button>
            <span>{selected?.symbol ?? '⭐'} {cost}</span>
            <button type="button" onClick={() => setCost((c) => c + 5)}>+</button>
          </div>
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="pill" onClick={onClose}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={saving || !title.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Add reward'}
          </button>
        </div>
      </div>
    </div>
  )
}
