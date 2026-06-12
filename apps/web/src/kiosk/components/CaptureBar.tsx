import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { usePersons, api, localToday } from '../../lib/api'
import { parseCapture, intentSummary, type ParsedIntent } from '../../lib/capture/parse'

// The "Add anything…" capture bar (roadmap 6.6). A compact trigger in the topbar
// opens a centered floating composer (multi-line, grows with your text). It shows
// an instant on-device parse and upgrades to the configured LLM as you type, and
// commits exactly what the preview shows on ↵ — never blocking on the model.
const VIA_LABEL: Record<string, string> = {
  'on-device': 'on-device',
  anthropic: 'Claude',
  openai: 'OpenAI',
  ollama: 'local LLM',
}

export function CaptureBar() {
  const { persons } = usePersons()
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null)
  const [server, setServer] = useState<{ intent: ParsedIntent | null; via: string; forText: string } | null>(null)
  const seq = useRef(0)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const names = useMemo(() => persons.map((p) => p.name), [persons])
  const localIntent = useMemo<ParsedIntent | null>(() => parseCapture(text, names), [text, names])

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
      const r = await api.resolve(text, names)
      if (mine === seq.current) {
        setServer({ intent: r.intent, via: r.via, forText: text })
        setThinking(false)
      }
    }, 350)
    return () => clearTimeout(id)
  }, [text, names])

  // Auto-grow the textarea (up to ~40vh) and keep it focused while open.
  useEffect(() => {
    const el = taRef.current
    if (!el || !expanded) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, expanded])

  const usingServer = server && server.forText === text
  const intent = usingServer ? server!.intent : localIntent
  const via = usingServer ? server!.via : 'on-device'

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
    await api.createChore({ title: i.title, personId: personId(i.personName), rewardAmount: i.stars ?? undefined, rrule: i.rrule ?? undefined })
    return `Added the “${i.title}” chore`
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || !text.trim()) return
    // Commit exactly what the preview shows — never wait on the model.
    const toCommit = intent
    if (!toCommit) {
      setFlash({ ok: false, msg: 'Couldn’t understand that — try rephrasing.' })
      return
    }
    setBusy(true)
    try {
      const msg = await commit(toCommit)
      setText('')
      setServer(null)
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
                  <div className="ai-spark">
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
                  <button type="submit" className="cap-go" aria-label="Add" disabled={busy || !text.trim()}>
                    ↵
                  </button>
                </div>
              </form>

              {flash ? (
                <div className={`cap-flash ${flash.ok ? 'ok' : 'err'}`}>
                  {flash.ok ? '✓' : '⚠'} {flash.msg}
                </div>
              ) : preview ? (
                <div className="cap-preview">
                  <div className="cap-icon">{preview.icon}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cap-kind">
                      {preview.kind}
                      <span className="cap-via">{thinking ? 'thinking…' : `via ${VIA_LABEL[via] ?? via}`}</span>
                    </div>
                    <div className="cap-primary">{preview.primary}</div>
                    {preview.detail && <div className="cap-detail">{preview.detail}</div>}
                  </div>
                  <div className="cap-hint">press ↵</div>
                </div>
              ) : (
                <div className="cap-empty-hint tiny muted">Type an event, chore, grocery item, or meal — I’ll sort it out.</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
