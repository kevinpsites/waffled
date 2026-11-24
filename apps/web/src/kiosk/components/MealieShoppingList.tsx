import { useEffect, useRef, useState, type FormEvent } from 'react'
import { mealieApi, useMealieQuery, type MealieShoppingItem } from '../../lib/api/mealie'
import { useTopbarFull } from '../topbar-slot'
import { MealieError } from './MealieError'

const UNLABELED = 'Other'

function groupByLabel(items: MealieShoppingItem[]) {
  const groups = new Map<string, { name: string; color: string | null; items: MealieShoppingItem[] }>()
  for (const i of [...items].sort((a, b) => a.position - b.position)) {
    const name = i.label?.name ?? UNLABELED
    const g = groups.get(name) ?? { name, color: i.label?.color ?? null, items: [] }
    g.items.push(i)
    groups.set(name, g)
  }
  return [...groups.values()].sort((a, b) => (a.name === UNLABELED ? 1 : b.name === UNLABELED ? -1 : a.name.localeCompare(b.name)))
}

export function MealieShoppingList({ onBack }: { onBack?: () => void }) {
  const { data, error, retry } = useMealieQuery(() => mealieApi.shopping(), [])
  // Optimistic overlay: holds while the PATCH is pending so a stale refetch can't flip the
  // item back. Once it succeeds it is settled and yields to the next server data, whatever its value.
  const [overlay, setOverlay] = useState<Map<string, { value: boolean; settled: boolean }>>(new Map())
  const inFlight = useRef<Set<string>>(new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const [showChecked, setShowChecked] = useState(false)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  useTopbarFull(
    () => (onBack ? (
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 14 }}>
        <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onBack}>‹ Lists</button>
      </div>
    ) : null),
    [onBack]
  )

  useEffect(() => {
    setOverlay((prev) => {
      const next = new Map([...prev].filter(([, o]) => !o.settled))
      return next.size === prev.size ? prev : next
    })
  }, [data])

  if (!data) return error ? <MealieError error={error} onRetry={retry} /> : null


  const items = data.items.map((i) => ({ ...i, checked: overlay.get(i.id)?.value ?? i.checked }))
  const open = items.filter((i) => !i.checked)
  const done = items.filter((i) => i.checked)

  async function toggle(i: MealieShoppingItem) {
    if (inFlight.current.has(i.id)) return
    inFlight.current.add(i.id)
    setFailure(null)
    setOverlay((m) => new Map(m).set(i.id, { value: !i.checked, settled: false }))
    try {
      await mealieApi.setChecked(i.id, !i.checked)
      setOverlay((m) => (m.has(i.id) ? new Map(m).set(i.id, { value: !i.checked, settled: true }) : m))
    } catch {
      setOverlay((m) => { const n = new Map(m); n.delete(i.id); return n })
      setFailure(`Couldn't update “${i.display}”. Try again.`)
    } finally {
      inFlight.current.delete(i.id)
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || adding) return
    setAdding(true)
    setFailure(null)
    try {
      await mealieApi.addItem(text)
      setDraft('')
    } catch {
      setFailure(`Couldn't add “${text}”. Try again.`)
    } finally {
      setAdding(false)
    }
  }

  const row = (i: MealieShoppingItem) => (
    <button key={i.id} type="button" className="list-item" aria-pressed={i.checked} onClick={() => toggle(i)}
      style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', opacity: i.checked ? 0.6 : 1, textDecoration: i.checked ? 'line-through' : undefined }}>
      <span aria-hidden>{i.checked ? '☑' : '☐'}</span>
      {i.display}
    </button>
  )

  return (
    <div className="lists-home" style={{ display: 'block', padding: 16 }}>
      <h2 style={{ marginBottom: 12 }}>{data.listName}</h2>
      {error != null && <MealieError error={error} onRetry={retry} />}
      <form className="ai-bar grocery-add" onSubmit={onAdd}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add to shopping list…" aria-label="Add to shopping list" />
      </form>
      {failure && <div role="alert" className="muted" style={{ padding: '8px 2px' }}>{failure}</div>}
      {open.length === 0 && done.length === 0 && <div className="muted" style={{ padding: '24px 2px', fontWeight: 600 }}>Nothing on the list yet.</div>}
      {groupByLabel(open).map((g) => (
        <section key={g.name} data-label-color={g.color ?? undefined} style={{ borderLeft: `4px solid ${g.color ?? 'transparent'}`, paddingLeft: 10, marginTop: 14 }}>
          <div className="lists-section-name">{g.name}</div>
          {g.items.map(row)}
        </section>
      ))}
      {done.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" aria-expanded={showChecked} onClick={() => setShowChecked((s) => !s)}>Checked ({done.length})</button>
          {showChecked && done.map(row)}
        </section>
      )}
    </div>
  )
}
