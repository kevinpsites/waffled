import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { usePantry, pantryApi, daysUntil, type PantryItem, type PantryItemInput } from '../lib/api'
import '../styles/pantry.css'

// A small expiry badge: red if past, amber within 3 days, muted date otherwise.
function ExpiryBadge({ expiresOn }: { expiresOn: string | null }) {
  const d = daysUntil(expiresOn)
  if (d == null) return null
  if (d < 0) return <span className="pantry-exp past">Expired</span>
  if (d === 0) return <span className="pantry-exp soon">Today</span>
  if (d <= 3) return <span className="pantry-exp soon">{d}d left</span>
  return <span className="pantry-exp">{expiresOn}</span>
}

// The Pantry screen — on-hand inventory grouped by location. Gated behind the
// optional `pantry` module (the nav entry is hidden when off; direct nav 403s).
export function Pantry() {
  const { items, locations, loading, error, refetch } = usePantry()
  const [editing, setEditing] = useState<PantryItem | 'new' | null>(null)

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error) return <div className="muted" style={{ padding: 30 }}>Pantry isn't enabled for this household — turn it on in Settings → Modules.</div>

  // Group items by location, in the household's configured order; anything with an
  // unknown location falls into "Other".
  const order = [...locations, 'Other']
  const byLoc = new Map<string, PantryItem[]>()
  for (const it of items) {
    const key = locations.includes(it.location) ? it.location : 'Other'
    ;(byLoc.get(key) ?? byLoc.set(key, []).get(key)!).push(it)
  }
  const groups = order.filter((loc) => (byLoc.get(loc)?.length ?? 0) > 0).map((loc) => ({ loc, items: byLoc.get(loc)! }))

  return (
    <div className="pantry-screen">
      <div className="pantry-head">
        <div>
          <div className="nk-serif pantry-title">Pantry</div>
          <div className="pantry-sub">{items.length} item{items.length === 1 ? '' : 's'} on hand</div>
        </div>
        <div className="pantry-head-actions">
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={() => setEditing('new')}>+ Add item</button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="pantry-empty">Nothing logged yet. Add what's in your freezer, fridge, and pantry.</div>
      ) : (
        <div className="pantry-groups">
          {groups.map(({ loc, items: list }) => (
            <div className="pantry-group" key={loc}>
              <div className="pantry-group-h">{loc}</div>
              <div className="pantry-list">
                {list.map((it) => (
                  <button type="button" key={it.id} className="pantry-item" onClick={() => setEditing(it)}>
                    <span className="pantry-item-main">
                      <span className="pantry-item-name">{it.name}</span>
                      {(it.amount || it.unit) && <span className="pantry-item-qty">{[it.amount, it.unit].filter(Boolean).join(' ')}</span>}
                    </span>
                    <span className="pantry-item-meta">
                      <ExpiryBadge expiresOn={it.expiresOn} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ItemModal
          item={editing === 'new' ? null : editing}
          locations={locations}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch() }}
        />
      )}
    </div>
  )
}

function ItemModal({ item, locations, onClose, onSaved }: {
  item: PantryItem | null
  locations: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [amount, setAmount] = useState(item?.amount ?? '')
  const [unit, setUnit] = useState(item?.unit ?? '')
  const [location, setLocation] = useState(item?.location ?? locations[0] ?? 'Pantry')
  const [expiresOn, setExpiresOn] = useState(item?.expiresOn ?? '')
  const [note, setNote] = useState(item?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    if (!name.trim() || saving) return
    setSaving(true)
    setErr(null)
    const input: PantryItemInput = {
      name: name.trim(), amount: amount.trim(), unit: unit.trim(), location,
      expiresOn: expiresOn || null, note: note.trim(),
    }
    try {
      if (item) await pantryApi.update(item.id, input)
      else await pantryApi.create(input)
      onSaved()
    } catch {
      setErr('Could not save — please try again.')
      setSaving(false)
    }
  }

  async function remove() {
    if (!item || saving) return
    setSaving(true)
    try { await pantryApi.remove(item.id); onSaved() } catch { setErr('Could not delete.'); setSaving(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{item ? 'Edit item' : 'Add to pantry'}</div>
        <label className="pantry-field"><span>Item</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ground beef" autoFocus />
        </label>
        <div className="pantry-field-row">
          <label className="pantry-field"><span>Amount</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2 / half" />
          </label>
          <label className="pantry-field"><span>Unit</span>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="lbs / bag" />
          </label>
        </div>
        <div className="pantry-field-row">
          <label className="pantry-field"><span>Location</span>
            <select value={location} onChange={(e) => setLocation(e.target.value)}>
              {locations.map((l) => <option key={l} value={l}>{l}</option>)}
              {!locations.includes(location) && <option value={location}>{location}</option>}
            </select>
          </label>
          <label className="pantry-field"><span>Expires (optional)</span>
            <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </label>
        </div>
        <label className="pantry-field"><span>Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="leftovers from Tuesday" />
        </label>
        {err && <div className="pantry-err">{err}</div>}
        <div className="pantry-modal-actions">
          {item && <button type="button" className="pill pantry-del" disabled={saving} onClick={remove}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="pill" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={saving || !name.trim()} onClick={save}>
            {saving ? 'Saving…' : item ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Today card — an at-a-glance "what's on hand," soonest-to-expire first. Lives in
// one of the Today columns (Today decides whether to show it, per the module's
// enabled state + "Show on Today" setting).
export function PantryCard() {
  const [items, setItems] = useState<PantryItem[] | null>(null)
  useEffect(() => {
    let alive = true
    pantryApi.list().then((d) => alive && setItems(d.items)).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!items) return null
  // Soonest expiry first (dated before undated), then name.
  const sorted = [...items].sort((a, b) => {
    const da = daysUntil(a.expiresOn), db = daysUntil(b.expiresOn)
    if (da == null && db == null) return a.name.localeCompare(b.name)
    if (da == null) return 1
    if (db == null) return -1
    return da - db
  })
  const soon = items.filter((it) => { const d = daysUntil(it.expiresOn); return d != null && d <= 3 }).length
  const shown = sorted.slice(0, 6)

  return (
    <div className="card pantry-card">
      <div className="pantry-card-h">
        <span className="pantry-card-title">🥫 Pantry</span>
        <span className="pantry-card-count">{items.length} on hand{soon > 0 ? ` · ${soon} soon` : ''}</span>
      </div>
      {items.length === 0 ? (
        <Link to="/pantry" className="pantry-card-empty">Nothing logged yet — add what's on hand ›</Link>
      ) : (
        <>
          <div className="pantry-card-list">
            {shown.map((it) => (
              <Link to="/pantry" key={it.id} className="pantry-card-row">
                <span className="pantry-card-name">{it.name}</span>
                {(it.amount || it.unit) && <span className="pantry-card-qty">{[it.amount, it.unit].filter(Boolean).join(' ')}</span>}
                <span className="pantry-card-meta"><ExpiryBadge expiresOn={it.expiresOn} /></span>
              </Link>
            ))}
          </div>
          {items.length > shown.length && <Link to="/pantry" className="pantry-card-more">View all {items.length} ›</Link>}
        </>
      )}
    </div>
  )
}
