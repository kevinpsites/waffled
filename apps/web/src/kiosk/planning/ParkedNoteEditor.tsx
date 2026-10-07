import { useEffect, useRef, useState, type FormEvent } from 'react'
import { looseEndsApi } from '../../lib/api'
import { ApiSendError } from '../../lib/api/client'

/**
 * FIX A NOTE THAT IS ALREADY PARKED — its words, its tag, or both. The only other repair would be
 * to drop it and type it again, and Drop is supposed to mean something rather than be backspace.
 *
 * ONE EDITOR, EVERY SURFACE THAT SHOWS A NOTE: the Horizon board and the shell's gold box are two
 * shapes of the same edit, so only the hosting row differs.
 *
 * THE TAG ROW IS THE HOST'S TO OFFER, because a note that has already LANDED somewhere must be
 * re-addressable to anywhere; either way the note's CURRENT tag is always a chip (see `chips`).
 * "No tag" is the ABSENCE of a tag and never a row the server sends — it submits `stepKey: null`.
 */
export interface ParkedTag {
  stepKey: string
  label: string
  hint?: string
}

export interface ParkedNoteEditorProps {
  id: string
  note: string
  stepKey: string | null
  /** The tags this surface offers. The current tag is added if it isn't among them. */
  tags: ParkedTag[]
  /** The session being planned, so the server can move this note's route entry with it. */
  sessionId?: string
  busy?: boolean
  onCancel: () => void
  /** The row the server actually wrote. The host updates its own list from this. */
  onSaved: (next: { id: string; note: string; stepKey: string | null }) => void
}

export function ParkedNoteEditor({
  id,
  note,
  stepKey,
  tags,
  sessionId,
  busy,
  onCancel,
  onSaved,
}: ParkedNoteEditorProps) {
  const [text, setText] = useState(note)
  const [tag, setTag] = useState<string | null>(stepKey)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // The current tag is always representable, even when this surface's list omits it.
  const chips: ParkedTag[] = tags.some((t) => t.stepKey === stepKey) || stepKey === null
    ? tags
    : [...tags, { stepKey, label: stepKey }]

  const disabled = !!busy || saving
  const trimmed = text.trim()
  // Nothing to send is not an error — it is Cancel with extra steps.
  const unchanged = trimmed === note.trim() && tag === stepKey

  function save(e: FormEvent) {
    e.preventDefault()
    if (disabled || !trimmed) return
    if (unchanged) {
      onCancel()
      return
    }
    setSaving(true)
    setError(null)
    looseEndsApi
      .update(id, {
        // Only what actually moved. Both fields are read for PRESENCE server-side, so sending the
        // tag unchanged would still rewrite the route entry for no reason.
        ...(trimmed === note.trim() ? {} : { note: trimmed }),
        ...(tag === stepKey ? {} : { stepKey: tag }),
        ...(sessionId ? { sessionId } : {}),
      })
      .then((r) => onSaved({ id: r.item.id, note: r.item.note, stepKey: r.item.stepKey }))
      // KEEP THE SENTENCE — the server's cap and its "that step isn't running" are the useful half.
      .catch((err: unknown) =>
        setError(
          err instanceof ApiSendError && typeof err.body?.message === 'string'
            ? err.body.message
            : "That didn't go through — try again."
        )
      )
      .finally(() => setSaving(false))
  }

  return (
    <form className="wp-pne" onSubmit={save} data-testid={`wp-pne-${id}`}>
      <input
        ref={inputRef}
        className="wp-pne-in"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        // The server's own cap (`parkItem`'s MAX_NOTE), so a long note is stopped here, not by a 400.
        maxLength={500}
        aria-label="Edit this note"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="wp-pne-tags" role="group" aria-label="Which step should look at this?">
        {chips.map((t) => (
          <button
            key={t.stepKey}
            type="button"
            className={`wp-pne-tag${tag === t.stepKey ? ' on' : ''}`}
            title={t.hint}
            disabled={disabled}
            aria-pressed={tag === t.stepKey}
            onClick={() => setTag(t.stepKey)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className={`wp-pne-tag${tag === null ? ' on' : ''}`}
          disabled={disabled}
          aria-pressed={tag === null}
          onClick={() => setTag(null)}
        >
          No tag
        </button>
      </div>
      {error && (
        <p className="wp-pne-err" role="alert">
          {error}
        </p>
      )}
      <div className="wp-pne-acts">
        <button type="submit" className="btn btn-primary wp-pne-act" disabled={disabled || !trimmed}>
          Save
        </button>
        <button type="button" className="btn btn-ghost wp-pne-act" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
