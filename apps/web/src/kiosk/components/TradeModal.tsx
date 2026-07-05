import { useState } from 'react'
import { conversionsApi, type Conversion } from '../../lib/api'

// Trade one currency for another for a specific person (the canonical home is the
// person profile, where their balances live). Anyone can convert their own
// balance; guarded on sufficient funds.
export function TradeModal({
  person,
  balances,
  conversions,
  onClose,
  onDone,
}: {
  person: { id: string; name: string | null }
  balances: { currency: string; balance: number }[]
  conversions: Conversion[]
  onClose: () => void
  onDone?: () => void
}) {
  const [convId, setConvId] = useState(conversions[0]?.id ?? '')
  const [times, setTimes] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const conv = conversions.find((c) => c.id === convId)
  const have = conv ? balances.find((x) => x.currency === conv.fromCurrency)?.balance ?? 0 : 0
  const cost = conv ? conv.fromAmount * times : 0
  const gain = conv ? conv.toAmount * times : 0
  const afford = !!conv && have >= cost && times > 0

  async function go() {
    if (!conv || !afford) return
    setBusy(true)
    setErr(null)
    try {
      await conversionsApi.apply(conv.id, person.id, times)
      onDone?.()
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
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 2 }}>Trade currencies</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>for {person.name}</div>

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
            <span className="tiny muted" style={{ marginLeft: 'auto' }}>has {have} {conv.from.symbol ?? ''}</span>
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
