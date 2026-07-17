import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Icon } from '../icons'
import { useTopbarFull } from '../topbar-slot'
import { groceryApi, useGroceryBoard, type GroceryBoardItem } from '../../lib/api'
import { StaplesModal } from './StaplesModal'
import '../../styles/grocery.css'

const AISLE_ORDER = ['Produce', 'Dairy & Chilled', 'Meat & Seafood', 'Pantry', 'Bakery', 'Frozen', 'Other']
// Aisles offered in the "move to section" picker. 'Other' is omitted — the board
// treats an 'Other' category as auto-filed anyway, so "Auto (by name)" covers it.
const AISLE_PICKER = AISLE_ORDER.filter((a) => a !== 'Other')
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

const MEAL_LABEL: Record<string, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }
const MEAL_EMOJI: Record<string, string> = { breakfast: '🍳', lunch: '🥪', dinner: '🍽️', snack: '🍎' }
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const

// Ambient attribution under an item name: meal-builder items read as auto-generated
// ("from meal plan"); hand-added items show who added them ("added by {name}").
// Subtle by design — same visual weight as the quantity metadata.
function ItemAttribution({ item }: { item: GroceryBoardItem }) {
  const fromMeal = item.source === 'auto' || (item.sourceRecipeIds?.length ?? 0) > 0
  if (fromMeal) {
    return (
      <span className="gattr gattr-meal">
        <span aria-hidden>🍽</span> from meal plan
      </span>
    )
  }
  const by = item.addedBy
  if (by?.name) {
    return (
      <span className="gattr gattr-by">
        {by.avatarEmoji && (
          <span
            className="gattr-av"
            aria-hidden
            style={by.colorHex ? { background: `${by.colorHex}22` } : undefined}
          >
            {by.avatarEmoji}
          </span>
        )}
        added by {by.name}
      </span>
    )
  }
  return null
}

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
  onSave: (patch: { name: string; quantity: string | null; section: string | null }) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(item.name)
  const [qty, setQty] = useState(item.quantity ?? '')
  // The aisle the item currently sits in (an explicit override, or '' = auto-filed
  // by name). Picking one writes `section` (category); "Auto" clears it.
  const [sec, setSec] = useState(item.section ?? '')

  if (editing) {
    return (
      <div className="gitem editing">
        <div className="gedit-line">
          <input className="gedit-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="item" />
          <input className="gedit-qty" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" />
        </div>
        <div className="gedit-line">
          <select className="gedit-sec" value={sec} onChange={(e) => setSec(e.target.value)} aria-label="Aisle">
            <option value="">Auto (by name)</option>
            {AISLE_PICKER.map((a) => <option key={a} value={a}>{AISLE_EMOJI[a] ? `${AISLE_EMOJI[a]} ` : ''}{a}</option>)}
          </select>
          <button type="button" className="gact ok" title="Save" onClick={() => { onSave({ name: name.trim() || item.name, quantity: qty.trim() || null, section: sec || null }); setEditing(false) }}>✓</button>
          <button type="button" className="gact" title="Cancel" onClick={() => setEditing(false)}>×</button>
        </div>
      </div>
    )
  }
  return (
    <div className={`gitem ${item.checked ? 'done' : ''}`} onClick={onToggle} role="button" tabIndex={0}>
      <span className="gck" aria-hidden>{item.checked ? CHECK : null}</span>
      <span className="gitem-body">
        <span className="gnm">{item.name}</span>
        <ItemAttribution item={item} />
      </span>
      <span className="gdots">
        {colors.map((c, i) => (
          <span key={i} className="gdot" style={{ background: c }} />
        ))}
      </span>
      {item.quantity && <span className="gqty">{item.quantity}</span>}
      <span className="gitem-acts" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="gact" title="Edit" onClick={() => { setName(item.name); setQty(item.quantity ?? ''); setSec(item.section ?? ''); setEditing(true) }}>✎</button>
        <button type="button" className="gact" title="Remove" onClick={onDelete}>🗑</button>
      </span>
    </div>
  )
}

// One rendered run of items — an aisle, a planned meal, an unscheduled recipe, or
// the trailing "Other items". `key` is the stable React/collapse identity (recipe
// ids for meal-view sections — titles are free text and can collide).
interface BoardSection {
  key: string
  aisle: string | null
  items: GroceryBoardItem[]
  mealType?: string
  unscheduled?: boolean
}

// Group items into ordered aisle sections; manual/uncategorized items lead, ungrouped.
function aisleSections(items: GroceryBoardItem[]): BoardSection[] {
  const ungrouped = items.filter((i) => !i.aisle)
  const byAisle = new Map<string, GroceryBoardItem[]>()
  for (const i of items) {
    if (!i.aisle) continue
    if (!byAisle.has(i.aisle)) byAisle.set(i.aisle, [])
    byAisle.get(i.aisle)!.push(i)
  }
  const out: BoardSection[] = []
  if (ungrouped.length) out.push({ key: '__none__', aisle: null, items: ungrouped })
  for (const a of AISLE_ORDER) if (byAisle.has(a)) out.push({ key: a, aisle: a, items: byAisle.get(a)! })
  for (const [a, list] of byAisle) if (!AISLE_ORDER.includes(a)) out.push({ key: a, aisle: a, items: list })
  return out
}

export function GroceryBoard({ onBack }: { onBack: () => void }) {
  const { board, loading, error, refetch } = useGroceryBoard()
  const navigate = useNavigate()
  const [view, setView] = useState<'aisle' | 'meal'>('aisle')
  const [draft, setDraft] = useState('')
  const [editStaples, setEditStaples] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [recent, setRecent] = useState<Set<string>>(new Set()) // just-checked, still lingering in the active list
  const [showDone, setShowDone] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()) // collapsed aisle/meal sections
  const toggleSection = (key: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const [railMeal, setRailMeal] = useState<string>('dinner') // which meal type the rail shows
  const rebuilt = useRef(false)
  const addRef = useRef<HTMLInputElement>(null)

  // First time, if nothing auto-built yet but meals are planned, build it.
  useEffect(() => {
    if (rebuilt.current || !board) return
    const hasAuto = board.items.some((i) => i.source === 'auto')
    if (!hasAuto && board.meals.length > 0) {
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
    board?.meals.forEach((d) => d.recipeId && m.set(d.recipeId, d.color))
    board?.unscheduled?.forEach((u) => m.set(u.recipeId, u.color))
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
  async function saveItem(item: GroceryBoardItem, patch: { name: string; quantity: string | null; section: string | null }) {
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

  const sections: BoardSection[] =
    view === 'aisle'
      ? aisleSections(activeItems)
      : (() => {
          // One section per planned recipe (deduped — a dish planned in two slots
          // shows once), tagged with the meal type so the breakdown reads
          // "Dinner · Tomato Pasta". Grouped by meal type (Breakfast → Lunch →
          // Dinner → Snack), then by day within each — mirrors the rail's
          // segment order and how people shop ("everything for the dinners").
          // Each item renders once: earlier sections claim shared items first
          // (planned meals before unscheduled recipes — mirrors iOS MealGrouping).
          const ord = (t: string) => MEAL_TYPES.indexOf(t as (typeof MEAL_TYPES)[number])
          const byMeal = [...board.meals].sort((a, b) => ord(a.mealType) - ord(b.mealType) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
          const seen = new Set<string>()
          const used = new Set<string>()
          const claim = (recipeId: string) => {
            const items = activeItems.filter((i) => !used.has(i.id) && i.sourceRecipeIds.includes(recipeId))
            items.forEach((i) => used.add(i.id))
            return items
          }
          const perMeal: BoardSection[] = []
          for (const d of byMeal) {
            if (!d.recipeId || seen.has(d.recipeId)) continue
            seen.add(d.recipeId)
            const items = claim(d.recipeId)
            if (items.length) perMeal.push({ key: `meal|${d.recipeId}`, aisle: d.title ?? 'Meal', items, mealType: d.mealType })
          }
          // Recipes added straight from a recipe page (not planned this week) get
          // their own sections after the planned meals — the "unscheduled" shelf.
          for (const u of board.unscheduled ?? []) {
            const items = claim(u.recipeId)
            if (items.length) perMeal.push({ key: `un|${u.recipeId}`, aisle: u.title ?? 'Recipe', items, unscheduled: true })
          }
          // Anything not claimed by a planned or unscheduled recipe — hand-added
          // items — still needs a home, or it would vanish in the By-meal view.
          const leftovers = activeItems.filter((i) => !used.has(i.id))
          return leftovers.length ? [...perMeal, { key: '__other__', aisle: 'Other items', items: leftovers }] : perMeal
        })()

  // Rail: a segment per meal type that's actually planned this week (defaults to
  // dinner), showing that type's meals.
  const availableMealTypes = MEAL_TYPES.filter((t) => board.meals.some((m) => m.mealType === t))
  const effectiveRailMeal = availableMealTypes.includes(railMeal as (typeof MEAL_TYPES)[number]) ? railMeal : availableMealTypes[0] ?? 'dinner'
  const railMeals = board.meals.filter((m) => m.mealType === effectiveRailMeal)

  // One section's markup. Sections with a header (aisles / meals) collapse; the
  // leading ungrouped/manual section has no header and always shows. Each
  // section's stable `key` (aisle name / recipe id) doubles as the React key
  // and the collapse key, namespaced by view.
  const renderSection = (sec: BoardSection) => {
    const key = `${view}|${sec.key}`
    const isCollapsed = !!sec.aisle && collapsed.has(key)
    return (
      <div key={key} className="grocery-section">
        {sec.aisle && (
          <div className="grocery-section-h" role="button" tabIndex={0} onClick={() => toggleSection(key)}>
            <span className={`cal-chev ${isCollapsed ? '' : 'open'}`}>›</span>
            {view === 'aisle' && AISLE_EMOJI[sec.aisle] && <span className="ga-emo">{AISLE_EMOJI[sec.aisle]}</span>}
            {view === 'meal' && sec.mealType && <span className={`meal-badge mt-${sec.mealType}`}>{MEAL_EMOJI[sec.mealType]} {MEAL_LABEL[sec.mealType]}</span>}
            {view === 'meal' && sec.unscheduled && <span className="meal-badge mt-unscheduled">Unscheduled</span>}
            {sec.aisle}
            <span className="ga-n">{sec.items.length}</span>
          </div>
        )}
        {!isCollapsed && sec.items.map((it) => (
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
    )
  }

  // Split sections into two columns by a prefix/suffix cut weighted by item count.
  // Because the cut is based on item counts (which don't change when a section is
  // collapsed), collapsing never moves a section to the other column; and because
  // it's a prefix/suffix (not interleaved), stacking on mobile keeps aisle order.
  const weights = sections.map((s) => s.items.length + 2)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  let splitIdx = sections.length
  for (let i = 0; i < sections.length; i++) {
    acc += weights[i]
    if (acc >= totalWeight / 2) { splitIdx = i + 1; break }
  }
  const colA = sections.slice(0, splitIdx)
  const colB = sections.slice(splitIdx)

  return (
    <div className="grocery-board">
      <div className="grocery-main">
        <div className="grocery-head">
          <div className="card-h wf-serif grocery-title">Grocery list</div>
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
            Nothing here yet — plan some meals in Meals, then it auto-builds, or add items above.
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
                <div className="grocery-col">{colA.map(renderSection)}</div>
                {colB.length > 0 && <div className="grocery-col">{colB.map(renderSection)}</div>}
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
            <div className="card-h">This week’s meals</div>
            {board.meals.length > 0 && (
              <button type="button" className="pill grocery-refresh" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={rebuild} disabled={refreshing} title="Rebuild the auto items from these meals (keeps what you added or checked off)">
                ↻ {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>
          {board.meals.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>No meals planned yet.</div>}
          {availableMealTypes.length > 0 && (
            <div className="seg rail-seg" style={{ marginBottom: 12 }}>
              {availableMealTypes.map((t) => (
                <button key={t} className={t === effectiveRailMeal ? 'on' : ''} onClick={() => setRailMeal(t)}>{MEAL_LABEL[t]}</button>
              ))}
            </div>
          )}
          {/* Rows with a linked recipe drill into it — parity with the iOS rail. */}
          {railMeals.map((d) => (
            <div
              key={`${d.date}-${d.mealType}-${d.recipeId ?? d.title}`}
              className={`gdinner ${d.recipeId ? 'link' : ''}`}
              {...(d.recipeId ? { role: 'button', tabIndex: 0, onClick: () => navigate(`/meals/recipe/${d.recipeId}`) } : {})}
            >
              <span className="gdinner-c" style={{ background: d.color }} />
              <span className="gdinner-day">{new Date(String(d.date).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className="gdinner-t">{d.title ?? '—'}</span>
              {d.recipeId && <span className="gdinner-chev">›</span>}
              <span className="gdinner-e" style={{ background: `${d.color}1f` }}>{d.emoji ?? MEAL_EMOJI[d.mealType] ?? '🍽️'}</span>
            </div>
          ))}
          {/* Off-plan recipes added from their pages — kept below a divider so the
              card stays a complete legend for the item dot colors. Not affected by
              the meal-type segment (they belong to no slot). */}
          {(board.unscheduled ?? []).length > 0 && (
            <>
              <div className="grocery-rail-div" />
              <div className="grocery-rail-sub">Unscheduled</div>
              {(board.unscheduled ?? []).map((u) => (
                <div key={u.recipeId} className="gdinner link" role="button" tabIndex={0} onClick={() => navigate(`/meals/recipe/${u.recipeId}`)}>
                  <span className="gdinner-c" style={{ background: u.color }} />
                  <span className="gdinner-t">{u.title}</span>
                  <span className="gdinner-chev">›</span>
                  <span className="gdinner-e" style={{ background: `${u.color}1f` }}>{u.emoji ?? '🍽️'}</span>
                </div>
              ))}
            </>
          )}
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
        </div>
      </div>

      {editStaples && <StaplesModal staples={board.staples} onClose={() => setEditStaples(false)} onChanged={refetch} />}
    </div>
  )
}
