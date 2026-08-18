import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Icon } from '../icons'
import { useTopbarFull } from '../topbar-slot'
import { groceryApi, mealBuilderApi, useGroceryBoard, type GroceryBoardItem, type GroceryMealDish } from '../../lib/api'
import { StaplesModal } from './StaplesModal'
import { ShareListModal } from './ShareListModal'
// The canonical aisle walking order lives with the share formatter, which needs
// the same order to group the shared text the way the board reads top-to-bottom.
import { AISLE_ORDER } from './share-list'
import '../../styles/grocery.css'

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

// Ambient attribution under an item name: items auto-generated from the meal plan
// read as such ("from meal plan"); hand-added items show who added them
// ("added by {name}").
// Subtle by design — same visual weight as the quantity metadata.
// "You already have this" — shown when something in the pantry matches the row.
//
// The row stays ON the list. The match is presence-only (it never compares quantities),
// so this is a nudge to check the shelf, not a verdict that you have enough: having "1
// bag" of rice says nothing about whether it covers the 2 cups a recipe wants. Which is
// why the badge shows the pantry item's OWN amount instead of a yes/no — the shopper is
// the one who can actually judge, and giving them the number is what lets them.
function PantryBadge({ item }: { item: GroceryBoardItem }) {
  const hit = item.pantry
  if (!hit) return null
  const amount = [hit.amount, hit.unit].map((s) => s?.trim()).filter(Boolean).join(' ')
  // Name the matched item when it differs from the row — the match is fuzzy ("chicken" ↔
  // "chicken breast"), so a bare "you have some" leaves you wondering *what* it found.
  const matched = hit.name.trim().toLowerCase() !== item.name.trim().toLowerCase() ? hit.name : null
  // Whichever half matters more goes first, because a crowded row (store chip + quantity)
  // leaves the body column narrow enough to ellipsize the tail.
  // Fuzzy match → the NAME leads: a row reading "Chicken" matched by "Boneless chicken
  // breast" is a difference that can change your mind, and "3 pack…" wouldn't tell you.
  // Exact match → the name is already the row's own, so only the amount adds anything.
  const detail = matched ? [matched, amount].filter(Boolean).join(' · ') : amount
  return (
    <span
      className="gpantry"
      title={`In your pantry${detail ? ` — ${detail}` : ''}. Still on the list: we can't tell whether it's enough.`}
    >
      <span aria-hidden>🥫</span> {detail || 'in pantry'}
    </span>
  )
}

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

// A Meal Builder plate in the week rail: ONE parent row (plate dot, day, name, a
// "Meal · N" count and a preview of its dishes' emoji) that expands into a child
// row per dish. The dishes share the plate's dot color — provenance is per-meal.
function PlateRow({
  name,
  color,
  dishes,
  day,
  open,
  onToggle,
  onOpenRecipe,
  onRemove,
}: {
  name: string
  color: string
  dishes: GroceryMealDish[]
  day?: string
  open: boolean
  onToggle: () => void
  onOpenRecipe: (recipeId: string) => void
  // Only an UNSCHEDULED plate offers this. A scheduled one comes off the list by
  // being unscheduled, so a × here would be a second, contradicting way to do it.
  onRemove?: () => void
}) {
  return (
    <Fragment>
      <div
        className="gdinner gdinner-plate link"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="gdinner-c" style={{ background: color }} />
        {day && <span className="gdinner-day">{day}</span>}
        <span className="gdinner-t">{name}</span>
        <span className="gplate-n">Meal · {dishes.length}</span>
        {onRemove && (
          <button
            type="button"
            className="gdinner-x"
            aria-label={`Remove ${name} from list`}
            title="Remove from list"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
          >×</button>
        )}
        <span className={`cal-chev ${open ? 'open' : ''}`}>›</span>
        <span className="gplate-strip" style={{ background: `${color}1f` }} aria-hidden>
          {dishes.slice(0, 4).map((d) => (
            <span key={d.recipeId}>{d.emoji ?? '🍽️'}</span>
          ))}
        </span>
      </div>
      {open &&
        dishes.map((d) => (
          <div
            key={d.recipeId}
            className="gdinner gdish link"
            role="button"
            tabIndex={0}
            onClick={() => onOpenRecipe(d.recipeId)}
          >
            <span className="gdinner-c gdish-c" style={{ background: color }} />
            <span className="gdinner-t">{d.title ?? '—'}</span>
            <span className="gdinner-chev">›</span>
            <span className="gdinner-e" style={{ background: `${color}1f` }}>{d.emoji ?? '🍽️'}</span>
          </div>
        ))}
    </Fragment>
  )
}

function ItemRow({
  item,
  colors,
  storeOptions,
  onToggle,
  onSave,
  onDelete,
}: {
  item: GroceryBoardItem
  colors: string[]
  storeOptions: string[]
  onToggle: () => void
  onSave: (patch: { name: string; quantity: string | null; section: string | null; store: string | null }) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(item.name)
  // Seed from the typable form ("1 1/2 lb"), not the displayed "1½ lb" — a glyph in a
  // text box is something you can only delete, not amend.
  const [qty, setQty] = useState(item.quantityInput ?? item.quantity ?? '')
  // The aisle the item currently sits in (an explicit override, or '' = auto-filed
  // by name). Picking one writes `section` (category); "Auto" clears it.
  const [sec, setSec] = useState(item.section ?? '')
  // Free-text store, backed by a datalist of previously-used names so "Costco" typed
  // once comes back as a suggestion (collapsing the Costco/costco split). '' = none.
  const [store, setStore] = useState(item.store ?? '')

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
          <input className="gedit-store" value={store} onChange={(e) => setStore(e.target.value)} placeholder="store" aria-label="Store" list="grocery-stores" />
          <datalist id="grocery-stores">{storeOptions.map((s) => <option key={s} value={s} />)}</datalist>
          <button type="button" className="gact ok" title="Save" onClick={() => { onSave({ name: name.trim() || item.name, quantity: qty.trim() || null, section: sec || null, store: store.trim() || null }); setEditing(false) }}>✓</button>
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
        {/* Inside the body column, NOT a fourth trailing chip. The row already carries
            meal dots, a quantity, sometimes a store, and two action buttons, and in the
            board's two-column layout there is no horizontal room left: as a sibling of
            those, the badge starved `.gitem-body` (flex:1; min-width:0) and wrapped the
            item name mid-word. Here it costs no width and wraps on its own line. */}
        <PantryBadge item={item} />
      </span>
      <span className="gdots">
        {colors.map((c, i) => (
          <span key={i} className="gdot" style={{ background: c }} />
        ))}
      </span>
      {item.store && <span className="gstore" title={`Store: ${item.store}`}>🏬 {item.store}</span>}
      {item.quantity && <span className="gqty">{item.quantity}</span>}
      <span className="gitem-acts" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="gact" title="Edit" onClick={() => { setName(item.name); setQty(item.quantityInput ?? item.quantity ?? ''); setSec(item.section ?? ''); setStore(item.store ?? ''); setEditing(true) }}>✎</button>
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
  // Set on an unscheduled PLATE section, so its header can offer "Remove from list".
  mealId?: string
  // Set when the plate's every item was already claimed by an earlier section: the
  // section renders as a header plus this line instead of silently disappearing.
  note?: string
  recipeId?: string
  store?: string
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

// Group items by their assigned store (alphabetical), with unassigned items in a
// trailing "No store" section so nothing goes missing in the By-store view. Keyed
// case-insensitively: the server snaps new writes onto one casing, but any row saved
// before that would otherwise get its own identically-labelled section (the header is
// uppercased in CSS, so "costco" and "Costco" both read as "COSTCO").
function storeSections(items: GroceryBoardItem[]): BoardSection[] {
  const byStore = new Map<string, { label: string; items: GroceryBoardItem[] }>()
  const none: GroceryBoardItem[] = []
  for (const i of items) {
    const s = i.store?.trim()
    if (!s) { none.push(i); continue }
    const key = s.toLowerCase()
    if (!byStore.has(key)) byStore.set(key, { label: s, items: [] })
    byStore.get(key)!.items.push(i)
  }
  const out: BoardSection[] = [...byStore.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, items: group }) => ({ key: `store|${label.toLowerCase()}`, aisle: label, items: group, store: label }))
  if (none.length) out.push({ key: '__nostore__', aisle: 'No store', items: none })
  return out
}

// Sunday-anchored week label relative to today: "This week" / "Next week" / "Week of Jul 27".
function weekLabel(weekStart: string): string {
  const start = new Date(weekStart + 'T00:00:00')
  const cur = new Date()
  cur.setHours(0, 0, 0, 0)
  cur.setDate(cur.getDate() - cur.getDay())
  const diffWeeks = Math.round((start.getTime() - cur.getTime()) / (7 * 86400000))
  if (diffWeeks === 0) return 'This week'
  if (diffWeeks === 1) return 'Next week'
  if (diffWeeks === -1) return 'Last week'
  return `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function GroceryBoard({ onBack }: { onBack: () => void }) {
  // null = the current week (server default); a date pins a specific week so you can
  // shop ahead without touching this week's list.
  const [weekStart, setWeekStart] = useState<string | null>(null)
  const { board, loading, error, refetch } = useGroceryBoard(weekStart ?? undefined)
  const navigate = useNavigate()
  const [view, setView] = useState<'aisle' | 'meal' | 'store'>('aisle')
  // "Share list": hand the unchecked items to a phone as text / share sheet / QR.
  const [sharing, setSharing] = useState(false)
  // Durable store quick-select (server distinct list), merged with stores in use on the
  // board so a just-typed one shows immediately too.
  const [storeSuggestions, setStoreSuggestions] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [editStaples, setEditStaples] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [recent, setRecent] = useState<Set<string>>(new Set()) // just-checked, still lingering in the active list
  const [showDone, setShowDone] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()) // collapsed aisle/meal sections
  const toggleSection = (key: string) =>
    setCollapsed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const [railMeal, setRailMeal] = useState<string>('dinner') // which meal type the rail shows
  // Meal Builder plates the rail has expanded into their dishes (keyed by meal id).
  // Collapsed by default so the rail stays a one-line-per-meal summary.
  const [openMeals, setOpenMeals] = useState<Set<string>>(new Set())
  const toggleMeal = (id: string) =>
    setOpenMeals((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const rebuilt = useRef<Set<string>>(new Set()) // weeks already auto-built (once each)
  const addRef = useRef<HTMLInputElement>(null)

  // The first time a week with planned meals but no auto items is viewed, build it —
  // keyed PER week so switching to a future week auto-populates it too (not just the
  // first week loaded). Never re-fires for a week already handled.
  useEffect(() => {
    if (!board || rebuilt.current.has(board.weekStart)) return
    const hasAuto = board.items.some((i) => i.source === 'auto')
    if (!hasAuto && board.meals.length > 0) {
      rebuilt.current.add(board.weekStart)
      groceryApi.rebuildGrocery(board.weekStart).then(refetch).catch(() => {})
    }
  }, [board, refetch])

  useTopbarFull(
    () => (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button className="pill" style={{ cursor: 'pointer' }} onClick={onBack}>‹ Lists</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button
            className="pill"
            style={{ cursor: 'pointer' }}
            title="Copy, share, or QR the list to any phone"
            onClick={() => setSharing(true)}
          >
            📤 Share list
          </button>
        </div>
      </div>
    ),
    [onBack]
  )

  // Provenance dot colors for an item. Two linkages have to be honored, because a
  // plate reaches its rows differently depending on how it got there:
  //  - a SCHEDULED plate is built by the weekly rebuild, which credits the dishes'
  //    recipe ids (no meal id) — so every dish maps to the plate's color;
  //  - an UNSCHEDULED plate ("Add plate to list") credits the plate itself on each
  //    row, so its meal id maps too.
  // Colors are de-duped, which is what makes the dots per-MEAL: a row two of a
  // plate's dishes both wanted still shows one dot, not one per dish.
  const colorFor = useMemo(() => {
    const byRecipe = new Map<string, string>()
    const byMeal = new Map<string, string>()
    // first writer wins, so a dish that is also scheduled on its own keeps its
    // own slot color rather than being repainted by a plate.
    const recipe = (id: string, c: string) => { if (!byRecipe.has(id)) byRecipe.set(id, c) }
    board?.meals.forEach((d) => {
      if (d.mealId) {
        byMeal.set(d.mealId, d.color)
        d.recipes?.forEach((r) => recipe(r.recipeId, d.color))
      } else if (d.recipeId) recipe(d.recipeId, d.color)
    })
    board?.unscheduledMeals?.forEach((m) => {
      byMeal.set(m.mealId, m.color)
      m.recipes.forEach((r) => recipe(r.recipeId, m.color))
    })
    board?.unscheduled?.forEach((u) => recipe(u.recipeId, u.color))
    return (item: { sourceRecipeIds?: string[]; sourceMealIds?: string[] }) => {
      const out = new Set<string>()
      for (const id of item.sourceMealIds ?? []) { const c = byMeal.get(id); if (c) out.add(c) }
      for (const id of item.sourceRecipeIds ?? []) { const c = byRecipe.get(id); if (c) out.add(c) }
      return [...out]
    }
  }, [board])

  // Load the durable store quick-select (refetched when the board changes so a
  // just-assigned store persists as a suggestion).
  useEffect(() => {
    // Tolerate a partial/garbled payload — the quick-select is a nicety, and letting a
    // non-array through here would throw while grouping and blank the whole board.
    groceryApi.stores().then((s) => setStoreSuggestions(Array.isArray(s) ? s : [])).catch(() => {})
  }, [board])

  // Merge server suggestions with stores in use on the current board (deduped) so a
  // store typed this session shows up before the next server round-trip. Deduped
  // case-insensitively — offering both "Costco" and "costco" defeats a quick-select.
  const storeOptions = useMemo(() => {
    const byKey = new Map<string, string>()
    const add = (s: string | null | undefined) => {
      const v = s?.trim()
      if (v && !byKey.has(v.toLowerCase())) byKey.set(v.toLowerCase(), v)
    }
    storeSuggestions.forEach(add)
    board?.items.forEach((i) => add(i.store))
    return [...byKey.values()]
  }, [storeSuggestions, board])

  if (loading && !board) return <div className="muted" style={{ padding: 30 }}>Loading…</div>
  if (error || !board) return <div className="muted" style={{ padding: 30 }}>Couldn’t load the grocery list.</div>

  // Active = unchecked, or checked within the grace window (still shown in place).
  // Completed = checked and past the grace window (tucked into the Completed section).
  const activeItems = board.items.filter((i) => !i.checked || recent.has(i.id))
  const completedItems = board.items.filter((i) => i.checked && !recent.has(i.id))

  // Plates added to the list without ever being scheduled. Their dishes render as
  // the plate's child rows, so a dish must never ALSO show up as a loose
  // unscheduled recipe (the server already drops it — this keeps the client honest
  // if it doesn't).
  const unscheduledMeals = board.unscheduledMeals ?? []
  const inAPlate = new Set(unscheduledMeals.flatMap((m) => m.recipes.map((r) => r.recipeId)))
  const looseUnscheduled = (board.unscheduled ?? []).filter((u) => !inAPlate.has(u.recipeId))

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
  async function saveItem(item: GroceryBoardItem, patch: { name: string; quantity: string | null; section: string | null; store: string | null }) {
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
  // Undo an off-plan "add recipe to grocery" — removes that recipe's items (keeping
  // any shared with another recipe) so it drops out of the Unscheduled shelf.
  async function removeUnscheduled(recipeId: string) {
    await groceryApi.removeRecipeFromGrocery(recipeId, board!.weekStart)
    refetch()
  }
  // The same undo for a whole plate added off-plan. Server-side it keeps any row the
  // week's own plan still needs, so removing a plate that shares a dish with a
  // scheduled meal doesn't strip that meal's shopping.
  async function removePlate(mealId: string) {
    await mealBuilderApi.removeFromList(mealId, board!.weekStart)
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
  // "Start over" — un-check everything on this week's list (Refresh keeps checks).
  async function startOver() {
    setRecent(new Set())
    await groceryApi.clearGroceryChecks(board!.weekStart)
    refetch()
  }

  const sections: BoardSection[] =
    view === 'aisle'
      ? aisleSections(activeItems)
      : view === 'store'
      ? storeSections(activeItems)
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
          // Claim by any of a set of recipe ids (a plate has several) and/or by the
          // plate id itself — an off-plan plate credits its rows with sourceMealIds,
          // while the weekly rebuild writes only recipe ids.
          // Who ended up listing each item, so a group that claimed nothing can say
          // where its shopping went rather than vanishing.
          const claimedBy = new Map<string, string>()
          const wants = (i: (typeof activeItems)[number], recipeIds: string[], mealId?: string | null) =>
            recipeIds.some((r) => i.sourceRecipeIds.includes(r)) || (!!mealId && (i.sourceMealIds ?? []).includes(mealId))
          const claimBy = (label: string, recipeIds: string[], mealId?: string | null) => {
            const items = activeItems.filter((i) => !used.has(i.id) && wants(i, recipeIds, mealId))
            items.forEach((i) => {
              used.add(i.id)
              claimedBy.set(i.id, label)
            })
            return items
          }
          const claim = (label: string, recipeId: string) => claimBy(label, [recipeId])
          const perMeal: BoardSection[] = []
          for (const d of byMeal) {
            // A plate slot has recipeId null and its dishes in `recipes[]`; keying
            // only off recipeId would skip it and dump its shopping in "Other items".
            if (d.mealId) {
              if (seen.has(d.mealId)) continue
              seen.add(d.mealId)
              const label = d.title ?? 'Meal'
              const items = claimBy(label, (d.recipes ?? []).map((r) => r.recipeId), d.mealId)
              if (items.length) perMeal.push({ key: `plate|${d.mealId}`, aisle: label, items, mealType: d.mealType })
              continue
            }
            if (!d.recipeId || seen.has(d.recipeId)) continue
            seen.add(d.recipeId)
            const label = d.title ?? 'Meal'
            const items = claim(label, d.recipeId)
            if (items.length) perMeal.push({ key: `meal|${d.recipeId}`, aisle: label, items, mealType: d.mealType })
          }
          // Plates added to the list without ever being scheduled get their own
          // sections alongside the off-plan recipes below.
          for (const p of board.unscheduledMeals ?? []) {
            if (seen.has(p.mealId)) continue
            seen.add(p.mealId)
            const label = p.name ?? 'Meal'
            const dishIds = (p.recipes ?? []).map((r) => r.recipeId)
            const items = claimBy(label, dishIds, p.mealId)
            if (items.length) {
              perMeal.push({ key: `unplate|${p.mealId}`, aisle: label, items, unscheduled: true, mealId: p.mealId })
              continue
            }
            // Everything this plate wants is already listed under an earlier meal.
            // Say so — dropping the section made an added plate look un-added.
            const elsewhere = activeItems.filter((i) => wants(i, dishIds, p.mealId))
            const owners = [...new Set(elsewhere.map((i) => claimedBy.get(i.id)).filter(Boolean))] as string[]
            if (elsewhere.length) {
              perMeal.push({
                key: `unplate|${p.mealId}`,
                aisle: label,
                items: [],
                unscheduled: true,
                mealId: p.mealId,
                note:
                  owners.length === 1
                    ? `All ${elsewhere.length} item${elsewhere.length === 1 ? '' : 's'} listed under ${owners[0]}`
                    : `All ${elsewhere.length} items listed under ${owners.slice(0, 2).join(' and ')}`,
              })
            }
          }
          // Recipes added straight from a recipe page (not planned this week) get
          // their own sections after the planned meals — the "unscheduled" shelf.
          for (const u of looseUnscheduled) {
            const items = claim(u.title ?? 'Recipe', u.recipeId)
            if (items.length) perMeal.push({ key: `un|${u.recipeId}`, aisle: u.title ?? 'Recipe', items, unscheduled: true, recipeId: u.recipeId })
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
            {view === 'store' && <span className="ga-emo">{sec.store ? '🏬' : '🛒'}</span>}
            {view === 'meal' && sec.mealType && <span className={`meal-badge mt-${sec.mealType}`}>{MEAL_EMOJI[sec.mealType]} {MEAL_LABEL[sec.mealType]}</span>}
            {view === 'meal' && sec.unscheduled && <span className="meal-badge mt-unscheduled">Unscheduled</span>}
            {sec.aisle}
            <span className="ga-n">{sec.items.length}</span>
            {/* Take an off-plan recipe back off the list (undo "add to grocery"). */}
            {sec.unscheduled && sec.recipeId && (
              <button
                type="button"
                className="linkbtn"
                style={{ marginLeft: 'auto' }}
                title="Remove this recipe's items from the list"
                onClick={(e) => { e.stopPropagation(); removeUnscheduled(sec.recipeId!) }}
              >
                Remove
              </button>
            )}
            {/* Same undo for a whole off-plan plate. */}
            {sec.unscheduled && sec.mealId && (
              <button
                type="button"
                className="linkbtn"
                style={{ marginLeft: 'auto' }}
                aria-label={`Remove from list`}
                title="Take this plate's items back off the list"
                onClick={(e) => { e.stopPropagation(); void removePlate(sec.mealId!) }}
              >
                Remove
              </button>
            )}
          </div>
        )}
        {!isCollapsed && sec.note && <div className="grocery-section-note tiny muted">{sec.note}</div>}
        {!isCollapsed && sec.items.map((it) => (
          <ItemRow
            key={it.id}
            item={it}
            colors={colorFor(it)}
            storeOptions={storeOptions}
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
            <button className={view === 'store' ? 'on' : ''} onClick={() => setView('store')}>By store</button>
            <button className={view === 'meal' ? 'on' : ''} onClick={() => setView('meal')}>By meal</button>
          </div>
        </div>

        {/* Week switcher — shop ahead for a future week without touching this week's list.
            Meal-derived items are per week; your typed items + staples show on every week. */}
        <div className="grocery-weeknav" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 12px' }}>
          <button type="button" className="pill meals-nav" aria-label="Previous week" onClick={() => setWeekStart(addDaysISO(board.weekStart, -7))}>
            <Icon name="cl" />
          </button>
          <div className="wf-serif" style={{ fontWeight: 700, minWidth: 132, textAlign: 'center' }}>{weekLabel(board.weekStart)}</div>
          <button type="button" className="pill meals-nav" aria-label="Next week" onClick={() => setWeekStart(addDaysISO(board.weekStart, 7))}>
            <Icon name="cr" />
          </button>
          {weekLabel(board.weekStart) !== 'This week' && (
            <button type="button" className="pill" style={{ marginLeft: 4 }} onClick={() => setWeekStart(null)}>This week</button>
          )}
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
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, gap: 8 }}>
            <div className="card-h">{weekLabel(board.weekStart)}’s meals</div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {board.items.some((i) => i.checked && i.weekStart) && (
                <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={startOver} title="Un-check this week’s items (your global manual list keeps its state)">
                  ⟲ Start over
                </button>
              )}
              {board.meals.length > 0 && (
                <button type="button" className="pill grocery-refresh" style={{ cursor: 'pointer' }} onClick={rebuild} disabled={refreshing} title="Rebuild the auto items from these meals (keeps what you added or checked off)">
                  ↻ {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              )}
            </div>
          </div>
          {board.meals.length === 0 && <div className="tiny muted" style={{ fontWeight: 600 }}>No meals planned yet.</div>}
          {availableMealTypes.length > 0 && (
            <div className="seg rail-seg" style={{ marginBottom: 12 }}>
              {availableMealTypes.map((t) => (
                <button key={t} className={t === effectiveRailMeal ? 'on' : ''} onClick={() => setRailMeal(t)}>{MEAL_LABEL[t]}</button>
              ))}
            </div>
          )}
          {railMeals.length > 0 && <div className="grocery-rail-sub">Scheduled</div>}
          {/* A plate is ONE row that expands into its dishes; a plain single-recipe
              slot keeps drilling straight into its recipe (parity with the iOS rail). */}
          {railMeals.map((d) =>
            d.mealId && (d.recipes?.length ?? 0) > 0 ? (
              <PlateRow
                key={`plate|${d.date}|${d.mealType}|${d.mealId}`}
                name={d.title ?? 'Meal'}
                color={d.color}
                dishes={d.recipes ?? []}
                day={new Date(String(d.date).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                open={openMeals.has(d.mealId)}
                onToggle={() => toggleMeal(d.mealId!)}
                onOpenRecipe={(id) => navigate(`/meals/recipe/${id}`)}
              />
            ) : (
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
            )
          )}
          {/* Plates and recipes put on the list without a slot — kept below a divider
              so the card stays a complete legend for the item dot colors. Not affected
              by the meal-type segment (they belong to no slot). */}
          {(unscheduledMeals.length > 0 || looseUnscheduled.length > 0) && (
            <>
              <div className="grocery-rail-div" />
              <div className="grocery-rail-sub">Unscheduled</div>
              {unscheduledMeals.map((m) => (
                <PlateRow
                  key={`plate|${m.mealId}`}
                  name={m.name}
                  color={m.color}
                  dishes={m.recipes}
                  open={openMeals.has(m.mealId)}
                  onToggle={() => toggleMeal(m.mealId)}
                  onOpenRecipe={(id) => navigate(`/meals/recipe/${id}`)}
                  onRemove={() => void removePlate(m.mealId)}
                />
              ))}
              {looseUnscheduled.map((u) => (
                <div key={u.recipeId} className="gdinner link" role="button" tabIndex={0} onClick={() => navigate(`/meals/recipe/${u.recipeId}`)}>
                  <span className="gdinner-c" style={{ background: u.color }} />
                  <span className="gdinner-t">{u.title}</span>
                  <button
                    type="button"
                    className="gdinner-x"
                    aria-label={`Remove ${u.title} from list`}
                    title="Remove from list"
                    onClick={(e) => { e.stopPropagation(); void removeUnscheduled(u.recipeId) }}
                  >×</button>
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
      {sharing && (
        <ShareListModal
          items={board.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            checked: i.checked,
            aisle: i.aisle,
            // A split run (Costco + the corner shop) is exactly what the person
            // holding the list needs to know; assignee likewise when it's set.
            store: i.store ?? null,
            assignee: i.assignee?.name ?? null,
          }))}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  )
}
