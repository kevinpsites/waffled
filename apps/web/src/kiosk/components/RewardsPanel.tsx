import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { rewardsApi, useRewardsHub, useHousehold, useConversions, conversionsApi, type Reward, type Currency, type Conversion, type PersonBalance } from '../../lib/api'

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
// approval queue, and a rewards catalog kids redeem against. Tap a reward to edit
// or remove it. Currencies come from the household catalog (Settings → Chores &
// rewards) — one-currency families just see one balance.
export function RewardsPanel() {
  const { rewards, balances, currencies, pending, loading, error, refetch } = useRewardsHub()
  const { person } = useHousehold()
  const { conversions } = useConversions()
  const isAdmin = !!person?.isAdmin
  const navigate = useNavigate()
  const [redeemFor, setRedeemFor] = useState<Reward | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Reward | null>(null)
  const [trading, setTrading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  // Archived (soft-deleted) rewards — admin only, shown in a collapsed section.
  const [archived, setArchived] = useState<Reward[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const loadArchived = useCallback(() => {
    if (!isAdmin) return
    rewardsApi.archivedRewards().then((d) => setArchived(d.rewards)).catch(() => setArchived([]))
  }, [isAdmin])
  useEffect(() => { loadArchived() }, [loadArchived, rewards.length])
  const afterCatalogChange = () => { refetch(); loadArchived() }
  async function restore(id: string) {
    setBusy(id)
    try { await rewardsApi.restoreReward(id); afterCatalogChange() } finally { setBusy(null) }
  }

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
        {conversions.length > 0 && (
          <button type="button" className="rw-trade-btn" onClick={() => setTrading(true)}>⇄ Trade</button>
        )}
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
              {/* tap the card to edit / remove */}
              <button type="button" className="rw-card-main" onClick={() => setEditing(r)} title="Edit reward">
                <div className="rw-card-emo">{r.emoji ?? '🎁'}</div>
                <div className="rw-card-title">{r.title}</div>
                <div className="rw-card-cost"><Coin currency={curOf(r.currency)} amount={r.cost} /></div>
                <div className="rw-card-edit-hint">Edit</div>
              </button>
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

      {/* archived rewards — admin only, collapsed; archiving keeps redemption history */}
      {isAdmin && archived.length > 0 && (
        <div className="rw-archived">
          <button type="button" className="rw-arch-head" onClick={() => setShowArchived((v) => !v)}>
            <span className={`rw-arch-caret ${showArchived ? 'open' : ''}`}>›</span>
            Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="rw-arch-list">
              {archived.map((r) => (
                <div key={r.id} className="rw-arch-row">
                  <span className="rw-arch-emo">{r.emoji ?? '🎁'}</span>
                  <span className="rw-arch-t">{r.title}</span>
                  <span className="rw-arch-cost"><Coin currency={curOf(r.currency)} amount={r.cost} /></span>
                  <button type="button" className="pill" disabled={busy === r.id} onClick={() => restore(r.id)}>Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(adding || editing) && (
        <RewardModal
          reward={editing ?? undefined}
          currencies={currencies}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={afterCatalogChange}
        />
      )}

      {trading && (
        <TradeModal conversions={conversions} balances={balances} onClose={() => setTrading(false)} onDone={refetch} />
      )}
    </div>
  )
}

// Trade one currency for another at a defined rate. Anyone can convert their own
// balance (per household decision); guarded on sufficient funds.
function TradeModal({ conversions, balances, onClose, onDone }: { conversions: Conversion[]; balances: PersonBalance[]; onClose: () => void; onDone: () => void }) {
  const [personId, setPersonId] = useState(balances[0]?.personId ?? '')
  const [convId, setConvId] = useState(conversions[0]?.id ?? '')
  const [times, setTimes] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const conv = conversions.find((c) => c.id === convId)
  const bal = balances.find((b) => b.personId === personId)
  const have = conv ? bal?.balances.find((x) => x.currency === conv.fromCurrency)?.balance ?? 0 : 0
  const cost = conv ? conv.fromAmount * times : 0
  const gain = conv ? conv.toAmount * times : 0
  const afford = have >= cost && times > 0

  async function go() {
    if (!conv || !afford) return
    setBusy(true)
    setErr(null)
    try {
      await conversionsApi.apply(conv.id, personId, times)
      onDone()
      onClose()
    } catch {
      setErr('Couldn’t complete that trade.')
      setBusy(false)
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>Trade currencies</div>

        <label className="field"><span>Who</span>
          <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            {balances.map((b) => <option key={b.personId} value={b.personId}>{b.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Trade</span>
          <select value={convId} onChange={(e) => setConvId(e.target.value)}>
            {conversions.map((c) => (
              <option key={c.id} value={c.id}>{c.fromAmount} {c.from.symbol ?? ''} {c.from.label ?? c.fromCurrency} → {c.toAmount} {c.to.symbol ?? ''} {c.to.label ?? c.toCurrency}</option>
            ))}
          </select>
        </label>
        <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 12, flexDirection: 'row' }}>
          <span style={{ margin: 0 }}>How many times</span>
          <div className="rw-cost-input">
            <button type="button" onClick={() => setTimes((t) => Math.max(1, t - 1))} style={{ border: 0, background: 'none', fontSize: 18, cursor: 'pointer' }}>−</button>
            <input type="number" min={1} value={times} onChange={(e) => setTimes(Math.max(1, Number(e.target.value) || 1))} aria-label="Times" />
            <button type="button" onClick={() => setTimes((t) => t + 1)} style={{ border: 0, background: 'none', fontSize: 18, cursor: 'pointer' }}>+</button>
          </div>
        </label>

        {conv && (
          <div className="rw-trade-summary">
            <span className="rw-trade-give">−{cost} {conv.from.symbol ?? ''}</span>
            <span className="conv-arrow">→</span>
            <span className="rw-trade-get">+{gain} {conv.to.symbol ?? ''}</span>
            <span className="tiny muted" style={{ marginLeft: 'auto' }}>{bal?.name} has {have} {conv.from.symbol ?? ''}</span>
          </div>
        )}
        {!afford && conv && <div className="tiny" style={{ color: 'var(--primary)', fontWeight: 700, marginTop: 6 }}>Not enough {conv.from.label ?? 'currency'} to trade {times}×.</div>}
        {err && <div className="tiny" style={{ color: 'var(--primary)', fontWeight: 700, marginTop: 6 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="pill" onClick={onClose}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy || !afford} onClick={go}>{busy ? 'Trading…' : 'Trade'}</button>
        </div>
      </div>
    </div>
  )
}

function RewardModal({ reward, currencies, onClose, onSaved }: { reward?: Reward; currencies: Currency[]; onClose: () => void; onSaved: () => void }) {
  const editing = !!reward
  const spendable = currencies.filter((c) => c.spendable)
  const [title, setTitle] = useState(reward?.title ?? '')
  const [emoji, setEmoji] = useState(reward?.emoji ?? '🎁')
  const [cost, setCost] = useState(reward?.cost ?? 10)
  const [currencyKey, setCurrencyKey] = useState(() => reward?.currency ?? (spendable.find((c) => c.isDefault) ?? spendable[0])?.key ?? 'stars')
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const selected = currencies.find((c) => c.key === currencyKey)

  async function save() {
    if (!title.trim()) return
    setSaving(true)
    try {
      const body = { title: title.trim(), emoji: emoji.trim() || null, cost: Math.max(0, Math.round(cost || 0)), currency: currencyKey }
      if (editing) await rewardsApi.updateReward(reward!.id, body)
      else await rewardsApi.createReward(body)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }
  async function del() {
    if (!reward) return
    if (!confirmDel) { setConfirmDel(true); return }
    setSaving(true)
    try {
      await rewardsApi.deleteReward(reward.id)
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
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{editing ? 'Edit reward' : 'Add a reward'}</div>
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
          <div className="rw-cost-input">
            <span className="rw-cost-sym">{selected?.symbol ?? '⭐'}</span>
            <input type="number" min={0} value={cost} onChange={(e) => setCost(Number(e.target.value))} aria-label="Cost" />
          </div>
        </label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 18 }}>
          {editing && (
            <button type="button" onClick={del} disabled={saving} title="Archived rewards keep their redemption history and can be restored"
              style={{ border: 0, background: 'none', font: 'inherit', fontWeight: 700, fontSize: 14, color: 'var(--primary)', cursor: 'pointer', padding: '8px 4px' }}>
              {confirmDel ? 'Tap again to archive' : 'Archive'}
            </button>
          )}
          <button type="button" className="pill" style={{ marginLeft: 'auto' }} onClick={onClose}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={saving || !title.trim()} onClick={save}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Add reward'}
          </button>
        </div>
      </div>
    </div>
  )
}
