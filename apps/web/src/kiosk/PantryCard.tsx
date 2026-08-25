import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { pantryApi, daysUntil, type PantryItem } from '../lib/api'
import '../styles/pantry.css'

// Today's pantry card, kept out of Pantry.tsx on purpose. Today is the index route,
// so anything it imports statically is downloaded on every cold start by every
// household — and pantry is an optional module that defaults to off. Living here, the
// card is a small module Today can load lazily, instead of dragging the 600-line
// pantry screen (and the zxing barcode decoder behind it) onto the critical path.

// A small expiry badge: red if past, amber within 3 days, muted date otherwise.
function ExpiryBadge({ expiresOn }: { expiresOn: string | null }) {
  const d = daysUntil(expiresOn)
  if (d == null) return null
  if (d < 0) return <span className="pantry-exp past">Expired</span>
  if (d === 0) return <span className="pantry-exp soon">Today</span>
  if (d <= 3) return <span className="pantry-exp soon">{d}d left</span>
  return <span className="pantry-exp">{expiresOn}</span>
}

export function PantryCard() {
  const [items, setItems] = useState<PantryItem[] | null>(null)
  useEffect(() => {
    let alive = true
    pantryApi.list().then((d) => alive && setItems(d.items.filter((i) => !i.usedUp))).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!items) return null
  const sorted = [...items].sort((a, b) => {
    const da = daysUntil(a.expiresOn), db = daysUntil(b.expiresOn)
    if (da == null && db == null) return a.name.localeCompare(b.name)
    if (da == null) return 1
    if (db == null) return -1
    return da - db
  })
  const soon = items.filter((it) => { const d = daysUntil(it.expiresOn); return d != null && d <= 3 }).length

  return (
    <Link to="/pantry" className="card pantry-card">
      <div className="pantry-card-h">
        <span className="pantry-card-title">🥫 Pantry</span>
        <span className="pantry-card-count">{items.length} on hand{soon > 0 ? ` · ${soon} soon` : ''}</span>
      </div>
      {items.length === 0 ? (
        <div className="pantry-card-empty">Nothing logged yet — add what's on hand ›</div>
      ) : (
        <div className="pantry-card-list">
          {sorted.map((it) => (
            <div key={it.id} className="pantry-card-row">
              <span className="pantry-card-name">{it.name}</span>
              {(it.amount || it.unit) && <span className="pantry-card-qty">{[it.amount, it.unit].filter(Boolean).join(' ')}</span>}
              <span className="pantry-card-meta"><ExpiryBadge expiresOn={it.expiresOn} /></span>
            </div>
          ))}
        </div>
      )}
    </Link>
  )
}
