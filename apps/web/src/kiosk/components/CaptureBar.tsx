import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { usePersons, api, localToday, type Person, type ListSummary } from '../../lib/api'
import { parseCapture, intentSummary, looksConfident, type ParsedIntent } from '../../lib/capture/parse'

// The "Add anything…" capture bar (roadmap 6.6). A compact trigger in the topbar
// opens a centered floating composer. It shows an instant on-device parse and
// upgrades to the configured LLM, commits exactly what the preview shows on ↵, and
// lets you edit the parsed result inline (fix text, re-route the type, set the
// basics — who/which list/when).
const VIA_LABEL: Record<string, string> = {
  'on-device': 'on-device',
  anthropic: 'Claude',
  openai: 'OpenAI',
  ollama: 'local LLM',
}
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']
const KINDS: Array<{ k: ParsedIntent['kind']; label: string }> = [
  { k: 'event', label: '📅 Event' },
  { k: 'list', label: '📝 List' },
  { k: 'grocery', label: '🛒 Grocery' },
  { k: 'task', label: '✅ Task' },
  { k: 'meal', label: '🍽️ Meal' },
]

const pad = (n: number) => String(n).padStart(2, '0')
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}
function eventWhen(date: string, time: string | null, allDay: boolean): string {
  const d = new Date(`${date}T${allDay ? '12:00' : time || '12:00'}:00`)
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return allDay ? `${day} · All day` : `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}
function mealWhen(date: string, mealType: string): string {
  const d = new Date(`${date}T12:00:00`)
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${cap(mealType)}`
}

function primaryOf(i: ParsedIntent): string {
  switch (i.kind) {
    case 'event':
    case 'task':
    case 'meal':
      return i.title
    case 'grocery':
      return i.name
    case 'list':
      return i.itemName
    case 'unsupported':
      return ''
  }
}
function withPrimary(i: ParsedIntent, v: string): ParsedIntent {
  switch (i.kind) {
    case 'event':
    case 'task':
    case 'meal':
      return { ...i, title: v }
    case 'grocery':
      return { ...i, name: v }
    case 'list':
      return { ...i, itemName: v }
    case 'unsupported':
      return i
  }
}
function rerouteKind(i: ParsedIntent, kind: ParsedIntent['kind'], today: string): ParsedIntent {
  const primary = primaryOf(i) || 'Item'
  const personName = i.kind === 'event' || i.kind === 'task' ? i.personName : null
  const quantity = i.kind === 'grocery' || i.kind === 'list' ? i.quantity : null
  switch (kind) {
    case 'event': {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return { kind: 'event', title: primary, startsAt: d.toISOString(), allDay: true, personName, whenLabel: eventWhen(localToday(), null, true) }
    }
    case 'task':
      return { kind: 'task', title: primary, personName, stars: null, rrule: null, scheduleLabel: '' }
    case 'grocery':
      return { kind: 'grocery', name: primary, quantity }
    case 'list':
      return { kind: 'list', itemName: primary, listName: i.kind === 'list' ? i.listName : null, quantity }
    case 'meal':
      return { kind: 'meal', title: primary, date: today, mealType: 'dinner', whenLabel: mealWhen(today, 'dinner') }
    default:
      return i
  }
}

// Compact person picker (chips). `allowNone` shows an "Up for grabs" / "Anyone" option.
function PersonChips({ persons, value, onChange, noneLabel }: { persons: Person[]; value: string | null; onChange: (name: string | null) => void; noneLabel: string }) {
  return (
    <div className="cap-people">
      <button type="button" className={`cap-person ${!value ? 'on' : ''}`} onClick={() => onChange(null)}>{noneLabel}</button>
      {persons.map((p) => {
        const on = value?.toLowerCase() === p.name.toLowerCase()
        const color = p.colorHex ?? '#6B6B70'
        return (
          <button key={p.id} type="button" className={`cap-person ${on ? 'on' : ''}`} style={on ? { borderColor: color, color, background: `${color}18` } : undefined} onClick={() => onChange(p.name)}>
            {p.avatarEmoji ?? '🙂'} {p.name}
          </button>
        )
      })}
    </div>
  )
}

// Per-kind "basics" — extends the inline edit beyond just the title.
function DraftFields({ intent, persons, lists, set, today }: { intent: ParsedIntent; persons: Person[]; lists: ListSummary[]; set: (i: ParsedIntent) => void; today: string }) {
  if (intent.kind === 'grocery') {
    return (
      <input className="cap-edit-sub" value={intent.quantity ?? ''} placeholder="quantity (optional, e.g. 2 lbs)" aria-label="Quantity" onChange={(e) => set({ ...intent, quantity: e.target.value || null })} />
    )
  }
  if (intent.kind === 'list') {
    const known = lists.some((l) => l.name === intent.listName)
    return (
      <>
        <select className="cap-edit-sub" value={known ? intent.listName ?? '' : '__new__'} aria-label="List" onChange={(e) => set({ ...intent, listName: e.target.value === '__new__' ? '' : e.target.value })}>
          {lists.map((l) => <option key={l.id} value={l.name}>{(l.emoji ? `${l.emoji} ` : '') + l.name}</option>)}
          <option value="__new__">＋ New list…</option>
        </select>
        {!known && (
          <input className="cap-edit-sub" value={intent.listName ?? ''} placeholder="new list name" aria-label="New list name" onChange={(e) => set({ ...intent, listName: e.target.value || null })} />
        )}
      </>
    )
  }
  if (intent.kind === 'task') {
    return (
      <>
        <PersonChips persons={persons} value={intent.personName} onChange={(name) => set({ ...intent, personName: name })} noneLabel="🙌 Up for grabs" />
        <label className="cap-stars">Stars <input type="number" min={0} value={intent.stars ?? 0} onChange={(e) => set({ ...intent, stars: Number(e.target.value) || null })} /></label>
      </>
    )
  }
  if (intent.kind === 'event') {
    const { date, time } = localParts(intent.startsAt)
    const upd = (d: string, t: string | null, allDay: boolean) => {
      const startsAt = new Date(`${d}T${allDay ? '12:00' : t || '12:00'}:00`).toISOString()
      set({ ...intent, startsAt, allDay, whenLabel: eventWhen(d, t, allDay) })
    }
    return (
      <>
        <PersonChips persons={persons} value={intent.personName} onChange={(name) => set({ ...intent, personName: name })} noneLabel="Nobody" />
        <div className="cap-edit-row">
          <input type="date" className="cap-edit-mini" value={date} onChange={(e) => upd(e.target.value, time, intent.allDay)} aria-label="Date" />
          {!intent.allDay && <input type="time" className="cap-edit-mini" value={time} onChange={(e) => upd(date, e.target.value, false)} aria-label="Time" />}
          <button type="button" className={`cap-person ${intent.allDay ? 'on' : ''}`} onClick={() => upd(date, time, !intent.allDay)}>All day</button>
        </div>
      </>
    )
  }
  if (intent.kind === 'meal') {
    return (
      <div className="cap-edit-row">
        <div className="cap-people">
          {MEAL_TYPES.map((mt) => (
            <button key={mt} type="button" className={`cap-person ${intent.mealType === mt ? 'on' : ''}`} onClick={() => set({ ...intent, mealType: mt, whenLabel: mealWhen(intent.date ?? today, mt) })}>{cap(mt)}</button>
          ))}
        </div>
        <input type="date" className="cap-edit-mini" value={intent.date ?? today} onChange={(e) => set({ ...intent, date: e.target.value, whenLabel: mealWhen(e.target.value, intent.mealType) })} aria-label="Date" />
      </div>
    )
  }
  return null
}

export function CaptureBar() {
  const { persons } = usePersons()
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  const [server, setServer] = useState<{ intent: ParsedIntent | null; via: string; forText: string } | null>(null)
  const [lists, setLists] = useState<ListSummary[]>([])
  const [draft, setDraft] = useState<ParsedIntent | null>(null)
  const seq = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const names = useMemo(() => persons.map((p) => p.name), [persons])
  const customLists = useMemo(() => lists.filter((l) => l.listType !== 'grocery'), [lists])
  const listNames = useMemo(() => customLists.map((l) => l.name), [customLists])
  const localIntent = useMemo<ParsedIntent | null>(() => parseCapture(text, names, new Date(), listNames), [text, names, listNames])

  useEffect(() => {
    let alive = true
    api.lists().then((d) => alive && setLists(d.lists)).catch(() => {})
    return () => { alive = false }
  }, [])

  // Debounced server resolve. ~0.8s after you stop typing, so we capture whole
  // phrases instead of hammering the model on every keystroke/space.
  useEffect(() => {
    if (!text.trim()) {
      setServer(null)
      setThinking(false)
      return
    }
    const mine = ++seq.current
    setThinking(true)
    const id = setTimeout(async () => {
      const r = await api.resolve(text, names, listNames)
      if (mine === seq.current) {
        setServer({ intent: r.intent, via: r.via, forText: text })
        setThinking(false)
      }
    }, 800)
    return () => clearTimeout(id)
  }, [text, names, listNames])

  useEffect(() => { setDraft(null) }, [text])

  useEffect(() => {
    const el = taRef.current
    if (!el || !expanded) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, expanded])

  const usingServer = server && server.forText === text
  const parsed = usingServer ? server!.intent : localIntent
  const via = usingServer ? server!.via : 'on-device'
  // While the model is still thinking and the on-device guess is just a weak
  // grocery fallback, don't assert it — show a thinking row instead.
  const thinkingPlaceholder = !usingServer && thinking && !looksConfident(localIntent, text)
  const intent = draft ?? (thinkingPlaceholder ? null : parsed)
  const editing = draft !== null

  function open() {
    setExpanded(true)
    setFlash(null)
    void api.warm()
    setTimeout(() => taRef.current?.focus(), 0)
  }
  function close() {
    setExpanded(false)
    setText('')
    setServer(null)
    setDraft(null)
    setThinking(false)
    setFlash(null)
  }

  function personId(name: string | null): string | null {
    if (!name) return null
    return persons.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null
  }

  async function commit(i: ParsedIntent): Promise<string> {
    if (i.kind === 'event') {
      await api.createEvent({ title: i.title, startsAt: i.startsAt, allDay: i.allDay, personId: personId(i.personName) })
      return `Added “${i.title}” to the calendar`
    }
    if (i.kind === 'grocery') {
      const label = i.quantity ? `${i.name} (${i.quantity})` : i.name
      await api.addGroceryItem(label)
      return `Added “${i.name}” to the grocery list`
    }
    if (i.kind === 'list') {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
      const named = (await api.lists()).lists.filter((l) => l.listType !== 'grocery')
      let target = i.listName
        ? named.find((l) => norm(l.name) === norm(i.listName!)) ??
          named.find((l) => norm(l.name).includes(norm(i.listName!)) || norm(i.listName!).includes(norm(l.name)))
        : undefined
      if (!target) target = await api.createList({ name: i.listName?.trim() || 'List' })
      await api.addListItem(target.id, { name: i.itemName, quantity: i.quantity ?? undefined })
      return `Added “${i.itemName}” to ${target.name}`
    }
    if (i.kind === 'meal') {
      const date = i.date ?? localToday()
      let recipeId: string | undefined
      try {
        const { recipes } = await api.recipes()
        const n = i.title.toLowerCase()
        const hit = recipes.find((r) => (r.title ?? '').toLowerCase() === n) ?? recipes.find((r) => (r.title ?? '').toLowerCase().includes(n))
        recipeId = hit?.id
      } catch {
        /* recipe lookup is best-effort */
      }
      await api.planSlot({ date, mealType: i.mealType, recipeId, title: recipeId ? undefined : i.title })
      return `Added “${i.title}” to ${i.mealType} (${i.whenLabel.split(' · ')[0]})`
    }
    if (i.kind === 'unsupported') return ''
    await api.createChore({ title: i.title, personId: personId(i.personName), rewardAmount: i.stars ?? undefined, rrule: i.rrule ?? undefined })
    return `Added the “${i.title}” chore${i.personName ? ` for ${i.personName}` : ''}`
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !text.trim()) return
    const toCommit = intent
    if (!toCommit) {
      setFlash({ ok: false, msg: 'Couldn’t understand that — try rephrasing.' })
      return
    }
    if (toCommit.kind === 'unsupported') {
      setFlash({ ok: false, msg: toCommit.reason })
      return
    }
    setBusy(true)
    try {
      const msg = await commit(toCommit)
      setText('')
      setServer(null)
      setDraft(null)
      setFlash({ ok: true, msg })
      setTimeout(() => {
        setFlash(null)
        setExpanded(false)
      }, 1500)
    } catch {
      setFlash({ ok: false, msg: 'Sign this kiosk in to add things.' })
    } finally {
      setBusy(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      close()
    }
  }

  const preview = intent ? intentSummary(intent) : null
  const canCommit = !!intent && intent.kind !== 'unsupported'

  return (
    <>
      <button type="button" className="ai-bar capture-trigger" onClick={open} style={{ flex: 1, maxWidth: 520 }}>
        <div className="ai-spark">
          <Icon name="spark" />
        </div>
        <span className={`cap-trigger-text ${text ? '' : 'ph'}`}>{text || 'Add anything… “Soccer Tue 4pm for Wally”'}</span>
      </button>

      {expanded &&
        createPortal(
          <div className="cap-overlay" onMouseDown={close}>
            <div className="cap-composer" onMouseDown={(e) => e.stopPropagation()}>
              <form onSubmit={submit}>
                <div className="cap-comp-row">
                  <div className={`ai-spark ${thinking ? 'thinking' : ''}`}>
                    <Icon name="spark" />
                  </div>
                  <textarea
                    ref={taRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={'Add anything…  “fish for dinner next Friday”'}
                    aria-label="Add anything"
                    rows={1}
                    disabled={busy}
                  />
                  <button type="submit" className="cap-go" aria-label="Add" disabled={busy || !text.trim() || !canCommit}>
                    ↵
                  </button>
                </div>
              </form>

              {flash ? (
                <div className={`cap-flash ${flash.ok ? 'ok' : 'err'}`}>
                  {flash.ok ? '✓' : '⚠'} {flash.msg}
                </div>
              ) : thinkingPlaceholder ? (
                <div className="cap-preview cap-thinking">
                  <div className="cap-icon">✦</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cap-kind">Reading that<span className="cap-via">thinking…</span></div>
                    <div className="cap-detail">One sec while I sort it out…</div>
                  </div>
                </div>
              ) : preview && intent ? (
                <div className={`cap-preview ${editing ? 'editing' : ''}`}>
                  <div className="cap-icon">{preview.icon}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cap-kind">
                      {preview.kind}
                      <span className="cap-via">{thinking ? 'thinking…' : `via ${VIA_LABEL[via] ?? via}`}</span>
                    </div>

                    {intent.kind === 'unsupported' ? (
                      <div className="cap-primary">{intent.reason}</div>
                    ) : editing ? (
                      <div className="cap-edit">
                        <input className="cap-edit-input" value={primaryOf(intent)} onChange={(e) => setDraft(withPrimary(intent, e.target.value))} aria-label="Edit" autoFocus />
                        <DraftFields intent={intent} persons={persons} lists={customLists} set={setDraft} today={localToday()} />
                        <div className="cap-kind-chips">
                          {KINDS.map(({ k, label }) => (
                            <button key={k} type="button" className={`cap-kind-chip ${intent.kind === k ? 'on' : ''}`} onClick={() => setDraft(rerouteKind(intent, k, localToday()))}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="cap-primary cap-primary-btn" onClick={() => setDraft(intent)} title="Tap to edit">
                          {preview.primary}
                          <span className="cap-edit-pencil">✎</span>
                        </button>
                        {preview.detail && <div className="cap-detail">{preview.detail}</div>}
                      </>
                    )}
                  </div>
                  <div className="cap-hint">{editing ? 'editing' : canCommit ? 'press ↵' : ''}</div>
                </div>
              ) : (
                <div className="cap-empty-hint tiny muted">Type an event, list item, chore, grocery, or meal — I’ll sort it out.</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
