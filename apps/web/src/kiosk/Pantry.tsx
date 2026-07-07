import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  usePantry, pantryApi, daysUntil, groceryApi, flaggedAllergens, uploadImage, ageLabel, monthsOnHand, ALLERGEN_LABELS, DIETARY_LABELS, productSourceLabel,
  type PantryItem, type PantryItemInput, type OffProduct, type ItemRecipe,
} from '../lib/api'
import { ScanModal } from './components/ScanModal'
import { CookFromPantry } from './components/CookFromPantry'
import { AllergenBadges, AllergenBadge, AllergenKey } from './components/Allergens'
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

// A compact per-item expiry sub-line (greyed when far off / absent).
function expiryText(expiresOn: string | null): { text: string; tone: 'past' | 'soon' | 'ok' | 'none' } {
  const d = daysUntil(expiresOn)
  if (d == null) return { text: 'No date', tone: 'none' }
  if (d < 0) return { text: 'Expired', tone: 'past' }
  if (d === 0) return { text: 'Today', tone: 'soon' }
  if (d <= 3) return { text: `${d} day${d === 1 ? '' : 's'}`, tone: 'soon' }
  return { text: expiresOn!, tone: 'ok' }
}

// Best-effort emoji from the item name (the product image is preferred when present).
// Covers the non-food a pantry holds too, so a scanned toilet-paper/soap without an
// image doesn't fall back to a food can.
const EMOJI_RULES: [RegExp, string][] = [
  [/beef|steak|burger/i, '🥩'], [/chicken|poultry/i, '🍗'], [/turkey/i, '🦃'], [/pork|bacon|ham|sausage/i, '🥓'],
  [/shrimp|prawn/i, '🦐'], [/fish|salmon|tuna|cod/i, '🐟'], [/pizza/i, '🍕'], [/lasagna|pasta|spaghetti|noodle/i, '🍝'],
  [/pie|pot pie/i, '🥧'], [/burrito|taco|wrap/i, '🌯'], [/bean/i, '🫘'], [/nugget/i, '🍗'], [/waffle|pancake/i, '🧇'],
  [/pea|veg|broccoli|spinach/i, '🥦'], [/berry|berries|fruit/i, '🫐'], [/ice cream|gelato/i, '🍦'], [/cheese/i, '🧀'],
  [/bread|bun|roll|bagel/i, '🍞'], [/milk|cream|yogurt/i, '🥛'], [/egg/i, '🥚'], [/rice/i, '🍚'], [/soup|broth/i, '🍲'],
  // Non-food
  [/toilet|tissue|paper towel|kitchen roll|napkin/i, '🧻'], [/laundry|detergent|fabric soften|dish soap|dishwash|cleaner|bleach|surface spray/i, '🧼'],
  [/shampoo|conditioner|lotion|moisturi|body wash|sunscreen|hand soap/i, '🧴'], [/toothpaste|toothbrush|floss/i, '🪥'],
  [/deodorant|razor|shav/i, '🪒'], [/diaper|wipe/i, '🧷'], [/trash bag|garbage bag/i, '🗑️'], [/battery|batteries/i, '🔋'],
  [/dog|cat|pet food|kibble/i, '🐾'], [/foil|wrap|ziploc|sandwich bag|storage bag/i, '📦'],
]
function foodEmoji(name: string): string {
  for (const [re, e] of EMOJI_RULES) if (re.test(name)) return e
  return '📦'
}

type SortKey = 'expiring' | 'az' | 'recent' | 'oldest'

// The Pantry screen — on-hand inventory with a location/smart-group sidebar, search,
// sort, Open Food Facts nutrition/allergens, and avoid-allergen warnings. Gated
// behind the optional `pantry` module (nav hidden when off; direct nav redirects).
export function Pantry() {
  const { items, locations, avoidAllergens, allergenPeople, lowThreshold, locationIcons, staleMonths, loading, error, refetch } = usePantry()
  // The effective warning set: household avoid-list ∪ allergens any member has.
  const effectiveAvoid = useMemo(() => Array.from(new Set([...avoidAllergens, ...Object.keys(allergenPeople)])), [avoidAllergens, allergenPeople])
  const avoidSet = useMemo(() => new Set(effectiveAvoid), [effectiveAvoid])
  const [view, setView] = useState<string>('all') // 'all' | 'use_soon' | 'running_low' | <location>
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('expiring')
  const [editing, setEditing] = useState<PantryItem | 'new' | null>(null)
  const [detail, setDetail] = useState<PantryItem | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [editAmt, setEditAmt] = useState<{ id: string; amount: string; unit: string } | null>(null)

  // Stepper: bump the numeric amount by ±1; a − that can't stay above zero marks used up.
  async function adjust(it: PantryItem, delta: number) {
    const n = parseFloat(it.amount)
    const next = Number.isFinite(n) ? n + delta : delta > 0 ? 1 : 0
    if (next <= 0) return markUsedUp(it)
    setBusy(it.id)
    try { await pantryApi.update(it.id, { amount: String(next) }); refetch() } finally { setBusy(null) }
  }
  async function saveAmt() {
    const e = editAmt
    setEditAmt(null)
    if (!e) return
    setBusy(e.id)
    try { await pantryApi.update(e.id, { amount: e.amount.trim(), unit: e.unit.trim() }); refetch() } finally { setBusy(null) }
  }
  async function markUsedUp(it: PantryItem) {
    setBusy(it.id)
    try { await pantryApi.update(it.id, { usedUp: true }); refetch() } finally { setBusy(null) }
  }
  async function toShoppingList(it: PantryItem) {
    setBusy(it.id)
    try { await groceryApi.addGroceryItem(it.name); await pantryApi.remove(it.id); refetch() } finally { setBusy(null) }
  }
  async function removeItem(it: PantryItem) {
    setBusy(it.id)
    try { await pantryApi.remove(it.id); refetch() } finally { setBusy(null) }
  }

  const isSoon = (i: PantryItem) => { const d = daysUntil(i.expiresOn); return d != null && d <= 3 }
  // Low when the numeric amount is at/below the item's own threshold, or the household default.
  const isLow = (i: PantryItem) => { const n = parseFloat(i.amount); return Number.isFinite(n) && n <= (i.lowAt ?? lowThreshold) }
  // Old when it's been on hand longer than the household's age threshold.
  const isOld = (i: PantryItem) => { const m = monthsOnHand(i.addedOn); return m != null && m >= staleMonths }

  const live = useMemo(() => items.filter((i) => !i.usedUp), [items])
  const used = useMemo(() => items.filter((i) => i.usedUp), [items])

  const counts = useMemo(() => {
    const byLoc: Record<string, number> = {}
    for (const i of live) {
      const loc = locations.includes(i.location) ? i.location : 'Other'
      byLoc[loc] = (byLoc[loc] ?? 0) + 1
    }
    return { all: live.length, use_soon: live.filter(isSoon).length, running_low: live.filter(isLow).length, aging: live.filter(isOld).length, byLoc }
  }, [live, locations, lowThreshold, staleMonths]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply the selected view, the search, then the sort.
  function applyView(list: PantryItem[]): PantryItem[] {
    let out = list
    if (view === 'use_soon') out = out.filter(isSoon)
    else if (view === 'running_low') out = out.filter(isLow)
    else if (view === 'aging') out = out.filter(isOld)
    else if (view !== 'all') out = out.filter((i) => (locations.includes(i.location) ? i.location : 'Other') === view)
    const s = q.trim().toLowerCase()
    if (s) out = out.filter((i) => i.name.toLowerCase().includes(s) || (i.brand ?? '').toLowerCase().includes(s))
    return out
  }
  function sortItems(list: PantryItem[]): PantryItem[] {
    const c = [...list]
    if (sort === 'az') c.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'recent') c.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    else if (sort === 'oldest') c.sort((a, b) => (a.addedOn ?? '').localeCompare(b.addedOn ?? '')) // longest on hand first
    else c.sort((a, b) => { // expiring: dated soonest first, undated last
      const da = daysUntil(a.expiresOn), db = daysUntil(b.expiresOn)
      if (da == null && db == null) return a.name.localeCompare(b.name)
      if (da == null) return 1
      if (db == null) return -1
      return da - db
    })
    return c
  }

  const shown = useMemo(() => sortItems(applyView(live)), [live, view, q, sort, locations, lowThreshold, staleMonths]) // eslint-disable-line react-hooks/exhaustive-deps
  const shownUsed = useMemo(() => applyView(used), [used, view, q, locations]) // eslint-disable-line react-hooks/exhaustive-deps

  const viewLabel = view === 'all' ? 'All items' : view === 'use_soon' ? 'Use soon' : view === 'running_low' ? 'Running low' : view === 'aging' ? 'Been a while' : view
  const soonInView = shown.filter(isSoon).length

  if (loading) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error) return <div className="muted" style={{ padding: 30 }}>Pantry isn't enabled for this household — turn it on in Settings → Modules.</div>

  const NAV: { key: string; label: string; icon: string; count: number }[] = [
    { key: 'all', label: 'All items', icon: '🗂️', count: counts.all },
    { key: 'use_soon', label: 'Use soon', icon: '⏰', count: counts.use_soon },
    { key: 'running_low', label: 'Running low', icon: '📉', count: counts.running_low },
    { key: 'aging', label: 'Been a while', icon: '🕰️', count: counts.aging },
  ]

  return (
    <div className="pl-wrap">
      <div className="pl-head">
        <div className="wf-serif pl-title">Pantry</div>
        <input className="pl-search" placeholder={`Search all ${counts.all} items…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pl-head-actions">
          <button type="button" className="pill" onClick={() => setScanning(true)}>⛶ Scan</button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} onClick={() => setEditing('new')}>+ Add item</button>
        </div>
      </div>

      <div className="pl-body">
        <aside className="pl-side">
          {NAV.map((n) => (
            <button key={n.key} type="button" className={`pl-navitem${view === n.key ? ' on' : ''}`} onClick={() => setView(n.key)}>
              <span className="pl-navitem-ic">{n.icon}</span>
              <span className="pl-navitem-l">{n.label}</span>
              <span className="pl-navitem-n">{n.count}</span>
            </button>
          ))}
          <div className="pl-side-sep" />
          {locations.map((loc) => (
            <button key={loc} type="button" className={`pl-navitem${view === loc ? ' on' : ''}`} onClick={() => setView(loc)}>
              <span className="pl-navitem-ic">{locationIcons[loc] || '📦'}</span>
              <span className="pl-navitem-l">{loc}</span>
              <span className="pl-navitem-n">{counts.byLoc[loc] ?? 0}</span>
            </button>
          ))}
          {(counts.byLoc.Other ?? 0) > 0 && (
            <button type="button" className={`pl-navitem${view === 'Other' ? ' on' : ''}`} onClick={() => setView('Other')}>
              <span className="pl-navitem-ic">📦</span><span className="pl-navitem-l">Other</span><span className="pl-navitem-n">{counts.byLoc.Other}</span>
            </button>
          )}
          <CookFromPantry items={live} onChanged={refetch} />
          <AllergenKey avoid={avoidSet} />
        </aside>

        <main className="pl-main">
          <div className="pl-main-head">
            <div className="pl-main-title">{viewLabel} <span className="pl-main-sub">· {shown.length} item{shown.length === 1 ? '' : 's'}{soonInView > 0 ? ` · ${soonInView} use soon` : ''}</span></div>
            <div className="seg pl-sort">
              <button className={sort === 'expiring' ? 'on' : ''} onClick={() => setSort('expiring')}>Expiring</button>
              <button className={sort === 'az' ? 'on' : ''} onClick={() => setSort('az')}>A–Z</button>
              <button className={sort === 'recent' ? 'on' : ''} onClick={() => setSort('recent')}>Recent</button>
              <button className={sort === 'oldest' ? 'on' : ''} onClick={() => setSort('oldest')}>Oldest</button>
            </div>
          </div>

          {shown.length === 0 && shownUsed.length === 0 ? (
            <div className="pantry-empty">{q.trim() ? 'Nothing matches your search.' : 'Nothing here yet. Add what’s on hand.'}</div>
          ) : (
            <div className="pl-grid">
              {shown.map((it) => {
                const exp = expiryText(it.expiresOn)
                const loc = locations.includes(it.location) ? it.location : 'Other'
                const itemAllergens = it.allergens ?? []
                return (
                  <div key={it.id} className={`pl-item${busy === it.id ? ' busy' : ''}`}>
                    <button type="button" className="pl-item-face" onClick={() => setDetail(it)}>
                      <span className="pl-emoji">{it.imageUrl ? <img src={it.imageUrl} alt="" /> : foodEmoji(it.name)}</span>
                      <span className="pl-item-text">
                        <span className="pl-name">{it.name}</span>
                        {/* Second line: Location · allergies · use-by */}
                        <span className="pl-sub">
                          <span className="pl-loc">{loc}</span>
                          {itemAllergens.length > 0 && <AllergenBadges allergens={itemAllergens} avoid={avoidSet} />}
                          {it.expiresOn && <span className={`pl-exp pl-exp-${exp.tone}`}>{exp.text}</span>}
                          {isOld(it) && <span className="pl-old" title={`In ${loc.toLowerCase()} since ${it.addedOn}`}>🕰️ {ageLabel(it.addedOn)}</span>}
                        </span>
                      </span>
                    </button>
                    <div className="pantry-step-wrap">
                      <div className="pantry-step">
                        <button type="button" className="pantry-step-btn minus" aria-label={`Use one ${it.name}`} disabled={busy === it.id} onClick={() => adjust(it, -1)}>−</button>
                        <button type="button" className="pantry-step-val" disabled={busy === it.id} onClick={() => setEditAmt({ id: it.id, amount: it.amount, unit: it.unit })}>
                          <span className="pantry-step-num">{it.amount || '—'}</span>
                          {it.unit && <span className="pantry-step-unit">{it.unit}</span>}
                        </button>
                        <button type="button" className="pantry-step-btn plus" aria-label={`Add one ${it.name}`} disabled={busy === it.id} onClick={() => adjust(it, 1)}>+</button>
                      </div>
                      {editAmt?.id === it.id && (
                        <>
                          <div className="pantry-amtpop-scrim" onClick={saveAmt} />
                          <div className="pantry-amtpop" role="dialog">
                            <div className="pantry-amtpop-caret" />
                            <div className="pantry-amtpop-h">Edit amount</div>
                            <div className="pantry-amtpop-row">
                              <input className="pantry-amtpop-num" value={editAmt.amount} autoFocus onChange={(e) => setEditAmt((c) => (c ? { ...c, amount: e.target.value } : c))} onKeyDown={(e) => { if (e.key === 'Enter') saveAmt() }} />
                              <input className="pantry-amtpop-unit" value={editAmt.unit} placeholder="unit" onChange={(e) => setEditAmt((c) => (c ? { ...c, unit: e.target.value } : c))} onKeyDown={(e) => { if (e.key === 'Enter') saveAmt() }} />
                            </div>
                            <div className="pantry-amtpop-help">Tap the number any time to type an exact amount — ½ a bag, 0.75 lb, whatever fits.</div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {shownUsed.length > 0 && (
            <div className="pl-used">
              <div className="pl-used-h">Used up</div>
              {shownUsed.map((it) => (
                <div key={it.id} className={`pantry-item used${busy === it.id ? ' busy' : ''}`}>
                  <div className="pantry-item-main static"><span className="pantry-item-name">{it.name}</span><span className="pantry-used-tag">• Used up</span></div>
                  <button type="button" className="pill btn-primary pantry-used-buy" style={{ color: '#fff', border: 0 }} disabled={busy === it.id} onClick={() => toShoppingList(it)}>+ Shopping list</button>
                  <button type="button" className="pill pantry-used-remove" disabled={busy === it.id} onClick={() => removeItem(it)}>Remove</button>
                </div>
              ))}
            </div>
          )}

        </main>
      </div>

      {scanning && (
        <ScanModal locations={locations} avoidAllergens={avoidAllergens} allergenPeople={allergenPeople} onClose={() => setScanning(false)} onAdded={refetch} />
      )}

      {detail && (
        <PantryDetail
          item={detail}
          avoidAllergens={avoidAllergens}
          allergenPeople={allergenPeople}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditing(detail); setDetail(null) }}
          onChanged={refetch}
        />
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

// The item detail sheet — Open Food Facts product card: photo/emoji, brand + pack
// size, CONTAINS allergen chips (avoided ones in red), the nutrition panel, and
// Edit. (PLAN IT IN / Cook this are deferred with the meal-planning work.)
function PantryDetail({ item, avoidAllergens, allergenPeople, onClose, onEdit, onChanged }: {
  item: PantryItem
  avoidAllergens: string[]
  allergenPeople: Record<string, string[]>
  onClose: () => void
  onEdit: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [amt, setAmt] = useState(item.amount)
  const [busy, setBusy] = useState(false)
  const [img, setImg] = useState(item.imageUrl)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [recipes, setRecipes] = useState<ItemRecipe[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { pantryApi.itemRecipes(item.id).then((d) => setRecipes(d.recipes)).catch(() => {}) }, [item.id])
  const flaggedList = flaggedAllergens(item, avoidAllergens, allergenPeople)
  const flagged = new Set(flaggedList)
  // Who the flagged allergens affect (for the "affects …" note).
  const affects = Array.from(new Set(flaggedList.flatMap((a) => allergenPeople[a] ?? [])))
  // "May contain" (traces) the household avoids → flag those too.
  const traceFlag = new Set((item.traces ?? []).filter((a) => avoidAllergens.includes(a) || allergenPeople[a]))
  const n = item.nutrition
  const isOff = item.source === 'openfoodfacts'
  // Attribution for whichever Open * Facts database this item came from (non-food
  // items resolve from the beauty/products/pet siblings); null for manual adds.
  const sourceLabel = productSourceLabel(item.source)

  async function replacePhoto(file: File | undefined) {
    if (!file) return
    setPhotoBusy(true)
    try {
      const up = await uploadImage(file)
      setImg(up.url)
      await pantryApi.update(item.id, { imageUrl: up.url })
      onChanged()
    } catch { /* ignore — keep old image */ } finally { setPhotoBusy(false) }
  }

  async function bump(delta: number) {
    const cur = parseFloat(amt)
    const next = Number.isFinite(cur) ? cur + delta : delta > 0 ? 1 : 0
    if (next <= 0) return
    setBusy(true)
    setAmt(String(next))
    try { await pantryApi.update(item.id, { amount: String(next) }); onChanged() } finally { setBusy(false) }
  }

  const nutriRows: [string, string][] = []
  if (n) {
    if (n.calories != null) nutriRows.push(['Calories', String(n.calories)])
    if (n.protein_g != null) nutriRows.push(['Protein', `${n.protein_g} g`])
    if (n.fat_g != null) nutriRows.push(['Total fat', `${n.fat_g} g`])
    if (n.carbs_g != null) nutriRows.push(['Carbohydrate', `${n.carbs_g} g`])
    if (n.sodium_mg != null) nutriRows.push(['Sodium', `${n.sodium_mg} mg`])
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pl-detail2" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close pl-d2-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="pl-d2-img">
          {sourceLabel && <span className="pl-off-tag">● {sourceLabel}</span>}
          {img ? <img src={img} alt="" /> : <span className="pl-d2-emoji">{foodEmoji(item.name)}</span>}
          <button type="button" className="pl-d2-replace" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
            {photoBusy ? 'Uploading…' : '📷 Replace photo'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => replacePhoto(e.target.files?.[0])} />
        </div>
        <div className="pl-d2-main">
        <div className="pl-detail-title">{item.name}</div>
        {(item.brand || item.quantityText) && <div className="pl-detail-sub">{[item.brand, item.quantityText].filter(Boolean).join(' · ')}</div>}

        <div className="pl-detail-rows">
          <div className="pl-detail-row"><span>Location</span><b>{item.location}</b></div>
          <div className="pl-detail-row"><span>Added</span><b className="pl-added-val">{item.addedOn ?? '—'}{ageLabel(item.addedOn) ? <span className="pl-age-chip">{ageLabel(item.addedOn)} ago</span> : null}</b></div>
          <div className="pl-detail-row"><span>Best by</span><b>{item.expiresOn ?? '—'}</b></div>
          <div className="pl-detail-row">
            <span>Amount</span>
            <div className="pantry-step">
              <button type="button" className="pantry-step-btn minus" disabled={busy} onClick={() => bump(-1)}>−</button>
              <span className="pantry-step-val" style={{ cursor: 'default' }}><span className="pantry-step-num">{amt || '—'}</span>{item.unit && <span className="pantry-step-unit">{item.unit}</span>}</span>
              <button type="button" className="pantry-step-btn plus" disabled={busy} onClick={() => bump(1)}>+</button>
            </div>
          </div>
        </div>

        {item.allergens && item.allergens.length > 0 && (
          <div className="pl-detail-contains">
            <span className="pl-contains-l">Contains</span>
            {item.allergens.map((a) => (
              <span key={a} className="pl-contains-item"><AllergenBadge allergen={a} avoid={flagged.has(a)} /> {ALLERGEN_LABELS[a] ?? a}</span>
            ))}
          </div>
        )}
        {affects.length > 0 && <div className="pl-affects">⚠ Affects {affects.join(', ')}</div>}

        {item.traces && item.traces.length > 0 && (
          <div className="pl-detail-contains">
            <span className="pl-contains-l">May contain</span>
            {item.traces.map((a) => (
              <span key={a} className="pl-contains-item"><AllergenBadge allergen={a} trace avoid={traceFlag.has(a)} /> {ALLERGEN_LABELS[a] ?? a}</span>
            ))}
          </div>
        )}

        {item.dietary && item.dietary.length > 0 && (
          <div className="pl-diet">
            {item.dietary.map((d) => <span key={d} className="pl-diet-chip">{DIETARY_LABELS[d] ?? d}</span>)}
          </div>
        )}

        {nutriRows.length > 0 && (
          <div className="pl-nutri">
            <div className="pl-nutri-h"><span>Nutrition</span><span className="pl-nutri-basis">{item.servingBasis}</span></div>
            {nutriRows.map(([k, v]) => (
              <div key={k} className="pl-nutri-row"><span>{k}</span><b>{v}</b></div>
            ))}
          </div>
        )}

        {isOff && <div className="pl-off-foot">● Nutrition &amp; allergens from Open Food Facts</div>}

        {recipes.length > 0 && (
          <div className="pl-planin">
            <div className="pl-planin-h">Plan it in</div>
            {recipes.slice(0, 4).map((r) => (
              <button type="button" key={r.recipeId} className="pl-cookm-row" onClick={() => navigate(`/meals/recipe/${r.recipeId}`)}>
                <span className="pl-cookm-emoji">{r.emoji ?? '🍽️'}</span>
                <span className="pl-cookm-name">{r.title}</span>
                <span className="pl-cookm-go">›</span>
              </button>
            ))}
          </div>
        )}

        <div className="pl-detail-acts">
          <button type="button" className="pill" onClick={onEdit}>Edit</button>
        </div>
        </div>
      </div>
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
  const [addedOn, setAddedOn] = useState(item?.addedOn ?? new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState(item?.note ?? '')
  const [lowAt, setLowAt] = useState(item?.lowAt != null ? String(item.lowAt) : '')
  const [isMeal, setIsMeal] = useState(item?.isMeal ?? false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Barcode → Open Food Facts prefill (adding only). `off` holds the looked-up
  // snapshot to store with the item.
  const [barcode, setBarcode] = useState('')
  const [off, setOff] = useState<OffProduct | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupMsg, setLookupMsg] = useState<string | null>(null)

  async function lookup() {
    const code = barcode.replace(/\D/g, '')
    if (!code || lookingUp) return
    setLookingUp(true)
    setLookupMsg(null)
    const p = await pantryApi.lookup(code)
    setLookingUp(false)
    if (!p) { setOff(null); setLookupMsg('Not found in a product database — enter the details below.'); return }
    setOff(p)
    if (p.name) setName(p.name)
    setLookupMsg(`Found: ${p.name ?? 'product'}${p.brand ? ` · ${p.brand}` : ''}`)
  }

  async function save() {
    if (!name.trim() || saving) return
    setSaving(true)
    setErr(null)
    const input: PantryItemInput = {
      name: name.trim(), amount: amount.trim(), unit: unit.trim(), location,
      expiresOn: expiresOn || null, note: note.trim(),
      addedOn: addedOn || undefined,
      lowAt: lowAt.trim() === '' ? null : Number(lowAt),
      isMeal,
      // Carry the OFF snapshot when the item was matched by barcode.
      ...(off ? {
        barcode: off.barcode, brand: off.brand, imageUrl: off.imageUrl, quantityText: off.quantityText,
        servingBasis: off.servingBasis, nutrition: off.nutrition, allergens: off.allergens, traces: off.traces, dietary: off.dietary, source: off.source,
      } : {}),
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
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{item ? 'Edit item' : 'Add to pantry'}</div>
        {!item && (
          <label className="pantry-field"><span>Barcode (optional)</span>
            <div className="pl-barcode-row">
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Scan or type a barcode" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup() } }} />
              <button type="button" className="pill" disabled={lookingUp || !barcode.trim()} onClick={lookup}>{lookingUp ? '…' : 'Look up'}</button>
            </div>
            {lookupMsg && <span className={`pl-lookup-msg${off ? ' ok' : ''}`}>{lookupMsg}</span>}
          </label>
        )}
        <label className="pantry-field"><span>Item</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ground beef" autoFocus={!!item} />
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
        <label className="pantry-field"><span>Added / bought (how long it's been on hand)</span>
          <input type="date" value={addedOn} onChange={(e) => setAddedOn(e.target.value)} />
        </label>
        <div className="pantry-field-row">
          <label className="pantry-field"><span>Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="leftovers from Tuesday" />
          </label>
          <label className="pantry-field"><span>Warn below (optional)</span>
            <input type="number" min="0" step="any" value={lowAt} onChange={(e) => setLowAt(e.target.value)} placeholder="default" />
          </label>
        </div>
        <label className="pantry-meal-toggle">
          <input type="checkbox" checked={isMeal} onChange={(e) => setIsMeal(e.target.checked)} />
          <span>It's a meal — ready to eat (leftovers, pre-made, or a protein to use up). Shows in “Cook from your pantry”.</span>
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

// Today card — an at-a-glance "what's on hand," soonest-to-expire first. Used-up
// items are excluded.
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
