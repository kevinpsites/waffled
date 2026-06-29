import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Icon } from './icons'
import { ListsModal } from './components/ListsModal'
import { ListItemModal } from './components/ListItemModal'
import { GroceryBoard } from './components/GroceryBoard'
import {
  groceryApi,
  useLists,
  useListDetail,
  usePersons,
  type ListItem,
  type ListSummary,
  type Person,
} from '../lib/api'
import { useTopbarRight } from './topbar-slot'
import '../styles/lists.css'

// "Nook suggests" chips are static in the handoff (no suggestion engine yet) —
// they add their label to the list when tapped. Called out in the summary.
const SUGGESTIONS = ['Bug spray', 'Phone chargers', 'Snacks for the drive', 'Trash bags']

const CHECK = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--ink-3)" strokeWidth="3">
    <path d="M5 12l5 5 9-10" />
  </svg>
)

// Pluralized summary line under the list name: "12 items · 2 packed".
function summaryLine(items: ListItem[]): string {
  const total = items.length
  const packed = items.filter((i) => i.checked).length
  const head = `${total} item${total === 1 ? '' : 's'}`
  return packed > 0 ? `${head} · ${packed} packed` : head
}

// Person avatar (color-tinted bubble + emoji), matching the handoff `av()`.
function Avatar({
  emoji,
  color,
  onClick,
}: {
  emoji: string | null
  color: string | null
  onClick?: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="av sm lav"
      style={{ background: `${color ?? '#A6A29B'}22` }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={onClick ? 'Assign' : undefined}
    >
      {emoji ?? '🙂'}
    </div>
  )
}

function ItemRow({
  item,
  people,
  onToggle,
  onAssign,
  onEdit,
  onDelete,
}: {
  item: ListItem
  people: Person[]
  onToggle: (item: ListItem) => void
  onAssign: (item: ListItem, personId: string | null) => void
  onEdit: (item: ListItem) => void
  onDelete: (item: ListItem) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const a = item.assignee
  // Lists are hand-built, so attribution is "added by {name}" only; guard on
  // source anyway so any stray auto item doesn't claim a person added it.
  const addedBy = item.source !== 'auto' ? item.addedBy : null

  return (
    <div className={`litem ${item.checked ? 'done' : ''}`} onClick={() => onToggle(item)}>
      <div className="lck" aria-label={item.checked ? 'Checked' : 'Not checked'}>
        {item.checked ? CHECK : null}
      </div>
      <span className="lnm">
        {item.name}
        {addedBy?.name && (
          <span className="gattr gattr-by">
            {addedBy.avatarEmoji && (
              <span
                className="gattr-av"
                aria-hidden
                style={addedBy.colorHex ? { background: `${addedBy.colorHex}22` } : undefined}
              >
                {addedBy.avatarEmoji}
              </span>
            )}
            added by {addedBy.name}
          </span>
        )}
      </span>
      {item.quantity ? <span className="lqty">{item.quantity}</span> : null}
      {/* always-visible (touch: no hover) edit + delete */}
      <div className="litem-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="litem-act" aria-label="Edit item" onClick={() => onEdit(item)}>✎</button>
        <button type="button" className="litem-act litem-del" aria-label="Delete item" onClick={() => onDelete(item)}>×</button>
      </div>
      <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
        {a ? (
          <Avatar emoji={a.avatarEmoji} color={a.colorHex} onClick={() => setMenuOpen((v) => !v)} />
        ) : (
          <button
            type="button"
            className="av sm lav"
            aria-label="Assign"
            style={{ background: 'var(--panel)', color: 'var(--ink-3)', border: 0, cursor: 'pointer', fontSize: 14 }}
            onClick={() => setMenuOpen((v) => !v)}
          >
            +
          </button>
        )}
        {menuOpen && (
          <div className="assign-menu" style={{ right: 0, top: 36 }}>
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onAssign(item, p.id)
                  setMenuOpen(false)
                }}
              >
                <span>{p.avatarEmoji ?? '🙂'}</span>
                {p.name}
              </button>
            ))}
            {a && (
              <button
                type="button"
                onClick={() => {
                  onAssign(item, null)
                  setMenuOpen(false)
                }}
              >
                <span>✕</span> Unassign
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Group items into ordered sections (null section → "Other"), preserving the
// API's order (unchecked first, then checked) within each section.
function groupBySection(items: ListItem[]): Array<{ title: string; key: string; items: ListItem[] }> {
  const order: string[] = []
  const map = new Map<string, ListItem[]>()
  for (const it of items) {
    const key = it.section ?? '__other__'
    if (!map.has(key)) {
      map.set(key, [])
      order.push(key)
    }
    map.get(key)!.push(it)
  }
  return order.map((key) => ({ key, title: key === '__other__' ? 'Items' : key, items: map.get(key)! }))
}

// Balance the sections across two columns by running item count (mirrors the
// mock's left/right split: Clothes+Kids | Gear).
function splitColumns(sections: ReturnType<typeof groupBySection>) {
  const left: typeof sections = []
  const right: typeof sections = []
  let lc = 0
  let rc = 0
  for (const s of sections) {
    if (lc <= rc) {
      left.push(s)
      lc += s.items.length + 1
    } else {
      right.push(s)
      rc += s.items.length + 1
    }
  }
  return [left, right] as const
}

export function Lists() {
  const { lists, loading: listsLoading, error: listsError, refetch: refetchLists } = useLists()
  const { persons } = usePersons()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingList, setEditingList] = useState<{ id: string; name: string; emoji: string | null } | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [draft, setDraft] = useState('')
  const addingRef = useRef(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  const [filterPerson, setFilterPerson] = useState<string | null>(null)
  const [filterMenu, setFilterMenu] = useState(false)
  const [itemModal, setItemModal] = useState<{ item: ListItem | null } | null>(null)
  const [groceryOpen, setGroceryOpen] = useState(false)

  // On first load, the grocery list opens straight into its auto-built board
  // (its primary view) rather than the plain sectioned list. Without this you'd
  // land on the grocery list rendered as bare sections.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current || lists.length === 0) return
    bootstrapped.current = true
    const grocery = lists.find((l) => l.listType === 'grocery')
    if (grocery && selectedId === null) {
      setSelectedId(grocery.id)
      setGroceryOpen(true)
    }
  }, [lists, selectedId])

  // The hub (sidebar + list view) never renders the grocery list as plain
  // sections — opening grocery is a full-screen board takeover instead.
  const selected: ListSummary | null = useMemo(() => {
    const byId = lists.find((l) => l.id === selectedId)
    if (byId && byId.listType !== 'grocery') return byId
    return lists.find((l) => l.listType !== 'grocery') ?? byId ?? lists[0] ?? null
  }, [lists, selectedId])
  const { items, loading: itemsLoading, setItems, refetch: refetchItems } = useListDetail(selected?.id ?? null)

  // Stable so GroceryBoard's topbar effect (deps: [onBack]) doesn't re-fire every
  // render — an inline lambda here caused an infinite setState loop.
  const closeGrocery = useCallback(() => setGroceryOpen(false), [])

  useTopbarRight(
    () => (
      <>
        {/* Share list is cosmetic in the handoff (no sharing backend yet). */}
        <button type="button" className="pill" aria-label="Share list" style={{ cursor: 'pointer' }}>
          📤 Share list
        </button>
        <button type="button" className="pill btn-primary topbar-new" onClick={() => setItemModal({ item: null })}>
          <Icon name="plus" />
          <span>Add item</span>
        </button>
      </>
    ),
    []
  )

  // Optimistic check toggle.
  async function toggle(item: ListItem) {
    const next = !item.checked
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: next } : i)))
    try {
      const updated = await groceryApi.patchListItem(item.id, { checked: next })
      setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)))
    } catch {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: item.checked } : i)))
    }
  }

  async function assign(item: ListItem, personId: string | null) {
    try {
      const updated = await groceryApi.patchListItem(item.id, { assignedTo: personId })
      setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)))
    } catch {
      /* keep current state on failure */
    }
  }

  // Optimistic delete; restore on failure.
  async function remove(item: ListItem) {
    let snapshot: ListItem[] = []
    setItems((prev) => {
      snapshot = prev
      return prev.filter((i) => i.id !== item.id)
    })
    try {
      await groceryApi.deleteItem(item.id)
      refetchLists()
    } catch {
      setItems(snapshot)
    }
  }

  async function addItem(name: string) {
    const trimmed = name.trim()
    if (!trimmed || !selected || addingRef.current) return
    addingRef.current = true
    try {
      const item = await groceryApi.addListItem(selected.id, { name: trimmed })
      setItems((prev) => [...prev, item])
      refetchLists()
    } finally {
      addingRef.current = false
    }
  }

  function onAddSubmit(e: FormEvent) {
    e.preventDefault()
    addItem(draft).then(() => setDraft(''))
  }

  // Reset selection if the selected list disappears.
  useEffect(() => {
    if (selectedId && !lists.some((l) => l.id === selectedId)) setSelectedId(null)
  }, [lists, selectedId])

  // Delete the selected list (and, server-side, its items). Two-tap confirm since
  // it discards anything not yet checked off.
  async function deleteSelected() {
    if (!selected) return
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    await groceryApi.deleteList(selected.id).catch(() => {})
    setConfirmDel(false)
    setSelectedId(null)
    refetchLists()
  }

  if (listsError) {
    return <div className="muted" style={{ padding: 30 }}>Couldn't load your lists — try reloading or signing in again.</div>
  }

  // The grocery list opens its dedicated auto-built board (takes over the screen).
  if (groceryOpen) {
    return <GroceryBoard onBack={closeGrocery} />
  }

  const visibleItems = filterPerson ? items.filter((i) => i.assignee?.personId === filterPerson) : items
  const sections = groupBySection(visibleItems)
  const [leftCol, rightCol] = splitColumns(sections)

  return (
    <div className="lists-home">
      <div className="lists-rail">
        <div className="lists-rail-label">YOUR LISTS</div>
        <div className="lists-rail-items">
          {lists.map((l) => {
            const on = l.id === selected?.id
            const auto = l.listType === 'grocery'
            return (
              <button
                key={l.id}
                type="button"
                className={`list-item ${on ? 'on' : ''}`}
                onClick={() => {
                  setSelectedId(l.id)
                  setGroceryOpen(l.listType === 'grocery')
                  setConfirmDel(false)
                }}
              >
                <span className="lemo">{l.emoji ?? '📝'}</span>
                {l.name}
                <span className={`lct ${auto ? 'auto' : ''}`}>
                  {auto ? `✦ ${l.itemCount}` : l.itemCount}
                </span>
              </button>
            )
          })}
          {!listsLoading && lists.length === 0 && (
            <div className="tiny muted" style={{ padding: '4px 8px', fontWeight: 600 }}>No lists yet.</div>
          )}
        </div>
        <button type="button" className="btn btn-ghost lists-new" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          New list
        </button>
      </div>

      <div className="lists-main">
        {selected && (
          <>
            <div className="lists-head">
              <div className="lists-head-emoji">{selected.emoji ?? '📝'}</div>
              <div className="card-h nk-serif lists-head-name">{selected.name}</div>
              <div className="muted" style={{ fontWeight: 600 }}>{summaryLine(items)}</div>
              <div className="filter-wrap" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="pill filter-pill" onClick={() => setFilterMenu((v) => !v)}>
                  <Icon name="filter" />
                  {filterPerson ? persons.find((p) => p.id === filterPerson)?.name ?? 'Everyone' : 'Everyone'}
                </button>
                {filterMenu && (
                  <div className="assign-menu" style={{ right: 0, top: 40 }}>
                    <button type="button" onClick={() => { setFilterPerson(null); setFilterMenu(false) }}>
                      <span>👪</span> Everyone
                    </button>
                    {persons.map((p) => (
                      <button key={p.id} type="button" onClick={() => { setFilterPerson(p.id); setFilterMenu(false) }}>
                        <span>{p.avatarEmoji ?? '🙂'}</span> {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" className="pill" style={{ cursor: 'pointer' }} title="Rename list" onClick={() => setEditingList({ id: selected.id, name: selected.name, emoji: selected.emoji })}>✎ Rename</button>
              <button type="button" className="pill" style={{ cursor: 'pointer', color: confirmDel ? 'var(--primary)' : undefined, borderColor: confirmDel ? 'var(--primary)' : undefined }} title="Delete list" onClick={deleteSelected}>
                {confirmDel ? 'Tap again to delete' : '🗑 Delete'}
              </button>
            </div>
            <div className="tiny muted lists-hint">
              Tap to check off · tap an avatar to assign · ×2 is the quantity
            </div>

            <form className="ai-bar lists-addbar" onSubmit={onAddSubmit}>
              <div className="ai-spark" aria-hidden>
                <Icon name="spark" />
              </div>
              <input
                ref={addInputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={'Add to this list… “bug spray and 2 water bottles”'}
                aria-label="Add to this list"
              />
              <div className="mic" aria-hidden>
                <Icon name="mic" />
              </div>
            </form>

            <div className="lists-suggest">
              <span className="tiny lists-suggest-label">Nook suggests:</span>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="sug-chip" onClick={() => addItem(s)}>
                  <svg viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: '<path d="M12 5v14M5 12h14"/>' }} />
                  {s}
                </button>
              ))}
            </div>

            {items.length === 0 && !itemsLoading ? (
              <div className="lists-empty">This list is empty — add something above.</div>
            ) : visibleItems.length === 0 ? (
              <div className="lists-empty">Nothing assigned to {persons.find((p) => p.id === filterPerson)?.name ?? 'them'} here.</div>
            ) : (
              <div className="lists-grid">
                {[leftCol, rightCol].map((col, ci) => (
                  <div key={ci} className="lists-col">
                    {col.map((sec) => (
                      <div key={sec.key} className="lists-section">
                        <div className="lists-section-title">{sec.title}</div>
                        {sec.items.map((it) => (
                          <ItemRow key={it.id} item={it} people={persons} onToggle={toggle} onAssign={assign} onEdit={(i) => setItemModal({ item: i })} onDelete={remove} />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {!selected && !listsLoading && (
          <div className="lists-empty">No list selected. Create one with “New list”.</div>
        )}
      </div>

      {creating && (
        <ListsModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            refetchLists()
            setSelectedId(id)
          }}
        />
      )}
      {editingList && (
        <ListsModal
          list={editingList}
          onClose={() => setEditingList(null)}
          onSaved={refetchLists}
        />
      )}
      {itemModal && selected && (
        <ListItemModal
          listId={selected.id}
          item={itemModal.item}
          persons={persons}
          sections={[...new Set(items.map((i) => i.section).filter((s): s is string => !!s))]}
          onClose={() => setItemModal(null)}
          onSaved={() => {
            refetchItems()
            refetchLists()
          }}
        />
      )}
    </div>
  )
}
