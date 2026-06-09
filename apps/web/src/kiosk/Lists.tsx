import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Icon } from './icons'
import { ListsModal } from './components/ListsModal'
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
  onRename,
  onDelete,
}: {
  item: ListItem
  people: Person[]
  onToggle: (item: ListItem) => void
  onAssign: (item: ListItem, personId: string | null) => void
  onRename: (item: ListItem, name: string) => void
  onDelete: (item: ListItem) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(item.name)
  const a = item.assignee

  function commit() {
    setEditing(false)
    onRename(item, name)
  }

  return (
    <div className={`litem ${item.checked ? 'done' : ''}`} onClick={() => !editing && onToggle(item)}>
      <div className="lck" aria-label={item.checked ? 'Checked' : 'Not checked'}>
        {item.checked ? CHECK : null}
      </div>
      {editing ? (
        <input
          className="lnm-edit"
          autoFocus
          value={name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(item.name)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="lnm">{item.name}</span>
      )}
      {item.quantity ? <span className="lqty">{item.quantity}</span> : null}
      <div className="litem-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="litem-act" aria-label="Rename item" onClick={() => { setName(item.name); setEditing(true) }}>✎</button>
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
  const [draft, setDraft] = useState('')
  const addingRef = useRef(false)
  const addInputRef = useRef<HTMLInputElement>(null)
  const [filterPerson, setFilterPerson] = useState<string | null>(null)
  const [filterMenu, setFilterMenu] = useState(false)

  const selected: ListSummary | null = useMemo(
    () => lists.find((l) => l.id === selectedId) ?? lists[0] ?? null,
    [lists, selectedId]
  )
  const { items, loading: itemsLoading, setItems } = useListDetail(selected?.id ?? null)

  useTopbarRight(
    () => (
      <>
        {/* Share list is cosmetic in the handoff (no sharing backend yet). */}
        <button type="button" className="pill" aria-label="Share list" style={{ cursor: 'pointer' }}>
          📤 Share list
        </button>
        <button type="button" className="pill btn-primary topbar-new" onClick={() => addInputRef.current?.focus()}>
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

  async function rename(item: ListItem, name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed === item.name) return
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, name: trimmed } : i)))
    try {
      const updated = await groceryApi.patchListItem(item.id, { name: trimmed })
      setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)))
    } catch {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, name: item.name } : i)))
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

  if (listsError) {
    return <div className="muted" style={{ padding: 30 }}>Sign this kiosk in to see your lists.</div>
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
                onClick={() => setSelectedId(l.id)}
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
                          <ItemRow key={it.id} item={it} people={persons} onToggle={toggle} onAssign={assign} onRename={rename} onDelete={remove} />
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
    </div>
  )
}
