import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { usePersons, api, localToday } from '../../lib/api'
import { parseCapture, intentSummary, type ParsedIntent } from '../../lib/capture/parse'

// The "Add anything…" capture bar (roadmap 6.6). A compact trigger in the topbar
// opens a centered floating composer (multi-line, grows with your text). It shows
// an instant on-device parse and upgrades to the configured LLM as you type, and
// commits exactly what the preview shows on ↵ — never blocking on the model. The
// parsed result is editable inline (fix the text, or re-route the type).
const VIA_LABEL: Record<string, string> = {
  'on-device': 'on-device',
  anthropic: 'Claude',
  openai: 'OpenAI',
  ollama: 'local LLM',
}

// Editable types offered as re-route chips (unsupported is terminal — rephrase).
const KINDS: Array<{ k: ParsedIntent['kind']; label: string }> = [
  { k: 'event', label: '📅 Event' },
  { k: 'list', label: '📝 List' },
  { k: 'grocery', label: '🛒 Grocery' },
  { k: 'task', label: '✅ Task' },
  { k: 'meal', label: '🍽️ Meal' },
]

// The main editable text of an intent (the "what").
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
// Re-route to another type, carrying over the text + compatible fields.
function rerouteKind(i: ParsedIntent, kind: ParsedIntent['kind'], today: string): ParsedIntent {
  const primary = primaryOf(i) || 'Item'
  const personName = i.kind === 'event' || i.kind === 'task' ? i.personName : null
  const quantity = i.kind === 'grocery' || i.kind === 'list' ? i.quantity : null
  switch (kind) {
    case 'event': {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      return { kind: 'event', title: primary, startsAt: d.toISOString(), allDay: true, personName, whenLabel: 'Today · All day' }
    }
    case 'task':
      return { kind: 'task', title: primary, personName, stars: null, rrule: null, scheduleLabel: '' }
    case 'grocery':
      return { kind: 'grocery', name: primary, quantity }
    case 'list':
      return { kind: 'list', itemName: primary, listName: i.kind === 'list' ? i.listName : null, quantity }
    case 'meal':
      return { kind: 'meal', title: primary, date: today, mealType: 'dinner', whenLabel: 'Today · Dinner' }
    default:
      return i
  }
}

export function CaptureBar() {
  const { persons } = usePersons()
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  const [server, setServer] = useState<{ intent: ParsedIntent | null; via: string; forText: string } | null>(null)
  const [listNames, setListNames] = useState<string[]>([])
  // Inline edit: a frozen, user-editable copy of the parsed result.
  const [draft, setDraft] = useState<ParsedIntent | null>(null)
  const seq = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const names = useMemo(() => persons.map((p) => p.name), [persons])
  const localIntent = useMemo<ParsedIntent | null>(() => parseCapture(text, names, new Date(), listNames), [text, names, listNames])

  // The household's named (non-grocery) lists — so "to the lake packing trip"
  // routes to a real list both on-device and as fallback.
  useEffect(() => {
    let alive = true
    api.lists().then((d) => alive && setListNames(d.lists.filter((l) => l.listType !== 'grocery').map((l) => l.name))).catch(() => {})
    return () => { alive = false }
  }, [])

  // Debounced server resolve to upgrade the preview as you type.
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
    }, 350)
    return () => clearTimeout(id)
  }, [text, names, listNames])

  // Editing freezes the preview; typing more text discards the edit and re-parses.
  useEffect(() => { setDraft(null) }, [text])

  // Auto-grow the textarea (up to ~40vh) and keep it focused while open.
  useEffect(() => {
    const el = taRef.current
    if (!el || !expanded) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, expanded])

  const usingServer = server && server.forText === text
  const parsed = usingServer ? server!.intent : localIntent
  const via = usingServer ? server!.via : 'on-device'
  const intent = draft ?? parsed
  const editing = draft !== null

  function open() {
    setExpanded(true)
    setFlash(null)
    void api.warm() // preload the model so ↵ is snappy
    setTimeout(() => taRef.current?.focus(), 0)
  }
  function close() {
    setExpanded(false)
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
      const { lists } = await api.lists()
      const named = lists.filter((l) => l.listType !== 'grocery')
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
    if (i.kind === 'unsupported') return '' // never reached (submit blocks)
    await api.createChore({ title: i.title, personId: personId(i.personName), rewardAmount: i.stars ?? undefined, rrule: i.rrule ?? undefined })
    return `Added the “${i.title}” chore`
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
      {/* Compact trigger in the topbar */}
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
                        <input
                          className="cap-edit-input"
                          value={primaryOf(intent)}
                          onChange={(e) => setDraft(withPrimary(intent, e.target.value))}
                          aria-label="Edit"
                          autoFocus
                        />
                        {intent.kind === 'list' && (
                          <input
                            className="cap-edit-sub"
                            value={intent.listName ?? ''}
                            onChange={(e) => setDraft({ ...intent, listName: e.target.value || null })}
                            placeholder="which list?"
                            aria-label="List name"
                          />
                        )}
                        <div className="cap-kind-chips">
                          {KINDS.map(({ k, label }) => (
                            <button
                              key={k}
                              type="button"
                              className={`cap-kind-chip ${intent.kind === k ? 'on' : ''}`}
                              onClick={() => setDraft(rerouteKind(intent, k, localToday()))}
                            >
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
