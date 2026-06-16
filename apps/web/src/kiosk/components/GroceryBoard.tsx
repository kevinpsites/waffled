import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../icons'
import { useTopbarFull } from '../topbar-slot'
import { groceryApi, useGroceryBoard, type GroceryBoardItem } from '../../lib/api'
import { StaplesModal } from './StaplesModal'
import '../../styles/grocery.css'

const AISLE_ORDER = ['Produce', 'Dairy & Chilled', 'Meat & Seafood', 'Pantry', 'Bakery', 'Frozen', 'Other']
const AISLE_EMOJI: Record<string, string> = {
  Produce: '🥬',
  'Dairy & Chilled': '🧀',
  'Meat & Seafood': '🍖',
  Pantry: '🥫',
  Bakery: '🍞',
  Frozen: '🧊',
  Other: '🛒',
}

const CHECK = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" strokeWidth="3">
    <path d="M5 12l5 5 9-10" />
  </svg>
)

// A checked item lingers in place this long (undo window) before tucking into the
// collapsible "Completed" section, so the active list keeps itself tidy.
const COMPLETE_GRACE_MS = 2000

function ItemRow({
  item,
  colors,
  onToggle,
  onSave,
  onDelete,
}: {
  item: GroceryBoardItem
  colors: string[]
  onToggle: () => void
  onSave: (patch: { name: string; quantity: string | null }) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(item.name)
  const [qty, setQty] = useState(item.quantity ?? '')

  if (editing) {
    return (
      <div className="gitem editing">
        <input className="gedit-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="item" />
        <input className="gedit-qty" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" />
        <button type="button" className="gact ok" title="Save" onClick={() => { onSave({ name: name.trim() || item.name, quantity: qty.trim() || null }); setEditing(false) }}>✓</button>
        <button type="button" className="gact" title="Cancel" onClick={() => setEditing(false)}>×</button>
      </div>
    )
  }
  return (
    <div className={`gitem ${item.checked ? 'done' : ''}`} onClick={onToggle} role="button" tabIndex={0}>
      <span className="gck" aria-hidden>{item.checked ? CHECK : null}</span>
      <span className="gnm">{item.name}</span>
      <span className="gdots">
        {colors.map((c, i) => (
          <span key={i} className="gdot" style={{ background: c }} />
        ))}
      </span>
      {item.quantity && <span className="gqty">{item.quantity}</span>}
      <span className="gitem-acts" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="gact" title="Edit" onClick={() => { setName(item.name); setQty(item.quantity ?? ''); setEditing(true) }}>✎</button>
        <button type="button" className="gact" title="Remove" onClick={onDelete}>🗑</button>
      </span>
    </div>
  )
}

// Group items into ordered aisle sections; manual/uncategorized items lead, ungrouped.
function aisleSections(items: GroceryBoardItem[]): Array<{ aisle: string | null; items: GroceryBoardItem[] }> {
  const ungrouped = items.filter((i) => !i.aisle)
  const byAisle = new Map<string, GroceryBoardItem[]>()
  for (const i of items) {
    if (!i.aisle) continue
    if (!byAisle.has(i.aisle)) byAisle.set(i.aisle, [])
    byAisle.get(i.aisle)!.push(i)
  }
  const out: Array<{ aisle: string | null; items: GroceryBoardItem[] }> = []
  if (ungrouped.length) out.push({ aisle: null, items: ungrouped })
  for (const a of AISLE_ORDER) if (byAisle.has(a)) out.push({ aisle: a, items: byAisle.get(a)! })
  for (const [a, list] of byAisle) if (!AISLE_ORDER.includes(a)) out.push({ aisle: a, items: list })
  return out
}

export function GroceryBoard({ onBack }: { onBack: () => void }) {
  const { board, loading, error, refetch } = useGroceryBoard()
  const [view, setView] = useState<'aisle' | 'meal'>('aisle')
  const [draft, setDraft] = useState('')
  const [editStaples, setEditStaples] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [recent, setRecent] = useState<Set<string>>(new Set()) // just-checked, still lingering in the active list
  const [showDone, setShowDone] = useState(false)
  const rebuilt = useRef(false)
  const addRef = useRef<HTMLInputElement>(null)

  // First time, if nothing auto-built yet but dinners exist, build it.
  useEffect(() => {
    if (rebuilt.current || !board) return
    const hasAuto = board.items.some((i) => i.source === 'auto')
    if (!hasAuto && board.dinners.length > 0) {
      rebuilt.current = true
      groceryApi.rebuildGrocery(board.weekStart).then(refetch).catch(() => {})
    }
  }, [board, refetch])

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={onBack}>‹ Lists</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button className="pill" style={{ cursor: 'pointer' }} title="Coming soon">⬆ Send to phone</button>
          <button className="pill" style={{ cursor: 'pointer' }} title="Coming soon">🛒 Order online</button>
        </div>
      </div>
    ),
    [onBack]
  )

  const colorFor = useMemo(() => {
    const m = new Map<string, string>()
    board?.dinners.forEach((d) => d.recipeId && m.set(d.recipeId, d.color))
    return (ids: string[]) => ids.map((id) => m.get(id)).filter(Boolean) as string[]
  }, [board])

  if (loading && !board) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !board) return <div className="muted" style={{ padding: 30 }}>Couldn’t load the grocery list.</div>

  // Active = unchecked, or checked within the grace window (still shown in place).
  // Completed = checked and past the grace window (tucked into the Completed section).
  const activeItems = board.items.filter((i) => !i.checked || recent.has(i.id))
  const completedItems = board.items.filter((i) => i.checked && !recent.has(i.id))

  async function toggle(item: GroceryBoardItem) {
    const next = !item.checked
    if (next) {
      // keep it visible briefly so an accidental tap is easy to undo, then it
      // drops into Completed on its own.
      setRecent((s) => new Set(s).add(item.id))
      setTimeout(() => setRecent((s) => { const n = new Set(s); n.delete(item.id); return n }), COMPLETE_GRACE_MS)
    } else {
      setRecent((s) => { const n = new Set(s); n.delete(item.id); return n })
    }
    await groceryApi.patchListItem(item.id, { checked: next })
    refetch()
  }
  async function saveItem(item: GroceryBoardItem, patch: { name: string; quantity: string | null }) {
    await groceryApi.patchListItem(item.id, patch)
    refetch()
  }
  async function deleteItem(item: GroceryBoardItem) {
    await groceryApi.deleteItem(item.id)
    refetch()
  }
  async function clearCompleted() {
    if (completedItems.length === 0) return
    await Promise.all(completedItems.map((i) => groceryApi.deleteItem(i.id)))
    refetch()
  }
  async function addItem(name: string) {
    const n = name.trim()
    if (!n) return
    await groceryApi.addGroceryItem(n)
    setDraft('')
    refetch()
  }
  function onAdd(e: FormEvent) {
    e.preventDefault()
    addItem(draft)
  }
  async function addStapleToList(name: string) {
    await groceryApi.addGroceryItem(name)
    refetch()
  }
  async function rebuild() {
    setRefreshing(true)
    try {
      await groceryApi.rebuildGrocery(board!.weekStart)
      refetch()
    } finally {
      setRefreshing(false)
    }
  }

  const sections =
    view === 'aisle'
      ? aisleSections(activeItems)
      : (() => {
          const dinnerIds = new Set(board.dinners.filter((d) => d.recipeId).map((d) => d.recipeId!))
          const perMeal = board.dinners
            .filter((d) => d.recipeId)
            .map((d) => ({ aisle: d.title ?? 'Meal', items: activeItems.filter((i) => i.sourceRecipeIds.includes(d.recipeId!)) }))
            .filter((s) => s.items.length > 0)
          // Anything not tied to one of this week's dinners — hand-added items AND
          // items added from a recipe that isn't planned this week — still needs a
          // home, or it would vanish in the By-meal view.
          const leftovers = activeItems.filter((i) => !i.sourceRecipeIds.some((id) => dinnerIds.has(id)))
          return leftovers.length ? [...perMeal, { aisle: 'Other items', items: leftovers }] : perMeal
        })()

  return (
    <div className="grocery-board">
      <div className="grocery-main">
        <div className="grocery-head">
          <div className="card-h nk-serif grocery-title">Grocery list</div>
          <div className="muted grocery-count" style={{ fontWeight: 600 }}>
            {activeItems.length} to get{completedItems.length > 0 ? ` · ${completedItems.length} done` : ''}
          </div>
          <div className="seg" style={{ marginLeft: 'auto' }}>
            <button className={view === 'aisle' ? 'on' : ''} onClick={() => setView('aisle')}>By aisle</button>
            <button className={view === 'meal' ? 'on' : ''} onClick={() => setView('meal')}>By meal</button>
          </div>
        </div>

        <form className="ai-bar grocery-add" onSubmit={onAdd}>
          <div className="ai-spark" aria-hidden><Icon name="spark" /></div>
          <input ref={addRef} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={'Add to groceries… “bananas and oat milk”'} aria-label="Add to groceries" />
          <div className="mic" aria-hidden><Icon name="mic" /></div>
        </form>

        {board.items.length === 0 ? (
          <div className="muted" style={{ padding: '24px 2px', fontWeight: 600 }}>
            Nothing here yet — plan some dinners in Meals, then it auto-builds, or add items above.
          </div>
        ) : (
          <>
            {activeItems.length === 0 && (
              <div className="muted" style={{ padding: '20px 2px', fontWeight: 600 }}>
                All done — everything’s in the cart. 🎉
              </div>
            )}
            {activeItems.length > 0 && (
              <div className="grocery-cols">
                {sections.map((sec, i) => (
                  <div key={i} className="grocery-section">
                    {sec.aisle && (
                      <div className="grocery-section-h">
                        {view === 'aisle' && AISLE_EMOJI[sec.aisle] && <span className="ga-emo">{AISLE_EMOJI[sec.aisle]}</span>}
                        {sec.aisle}
                        <span className="ga-n">{sec.items.length}</span>
                      </div>
                    )}
                    {sec.items.map((it) => (
                      <ItemRow
                        key={it.id}
                        item={it}
                        colors={colorFor(it.sourceRecipeIds)}
                        onToggle={() => toggle(it)}
                        onSave={(patch) => saveItem(it, patch)}
                        onDelete={() => deleteItem(it)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Completed — checked items tuck here; collapsible, un-check to restore. */}
            {completedItems.length > 0 && (
              <div className="grocery-done">
                <div className="grocery-done-h" role="button" tabIndex={0} onClick={() => setShowDone((v) => !v)}>
                  <span className={`cal-chev ${showDone ? 'open' : ''}`}>›</span>
                  <span>Completed</span>
                  <span className="ga-n">{completedItems.length}</span>
                  <button type="button" className="linkbtn" style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); clearCompleted() }}>
                    Clear
                  </button>
                </div>
                {showDone && (
                  <div className="grocery-done-list">
                    {completedItems.map((it) => (
                      <div key={it.id} className="gitem done" onClick={() => toggle(it)} role="button" tabIndex={0} title="Tap to un-check">
                        <span className="gck" aria-hidden>{CHECK}</span>
                        <span className="gnm">{it.name}</span>
                        {it.quantity && <span className="gqty">{it.quantity}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="grocery-rail">
        <div className="card grocery-railcard">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div className="card-h">This week’s dinners</div>
            {board.dinners.length > 0 && (
              <button type="button" className="pill grocery-refresh" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={rebuild} disabled={refreshing} title="Rebuild the auto items from these dinners (keeps what you added or checked off)">
                ↻ {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>
          {board.dinners.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>No dinners planned yet.</div>}
          {board.dinners.map((d) => (
            <div key={d.date} className="gdinner">
              <span className="gdinner-c" style={{ background: d.color }} />
              <span className="gdinner-day">{new Date(String(d.date).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className="gdinner-t">{d.title ?? '—'}</span>
              <span className="gdinner-e" style={{ background: `${d.color}1f` }}>{d.emoji ?? '🍽️'}</span>
            </div>
          ))}
        </div>

        <div className="card grocery-railcard">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <div className="card-h">Pantry check</div>
            <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setEditStaples(true)}>☼ Edit staples</button>
          </div>
          <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 10 }}>
            These staples are assumed in the house, so they’re left off the list. Tap one to add it anyway.
          </div>
          <div className="grocery-staples">
            {board.staples.map((s) => (
              <button key={s.id} type="button" className="staple-chip" onClick={() => addStapleToList(s.name)}>{s.name}</button>
            ))}
          </div>
          <div className="grocery-railfoot">
            <button type="button" className="btn btn-ghost" onClick={() => addRef.current?.focus()}>＋ Add item</button>
            <button type="button" className="btn btn-primary" title="Sharing comes with device pairing">⬆ Share</button>
          </div>
        </div>
      </div>

      {editStaples && <StaplesModal staples={board.staples} onClose={() => setEditStaples(false)} onChanged={refetch} />}
    </div>
  )
}
