import { useEffect, useRef, useState, type FormEvent } from 'react'
import { looseEndsApi } from '../../lib/api'
import { ApiSendError } from '../../lib/api/client'
import type { ParkedTag } from './ParkedNoteEditor'

/**
 * PARK A NOTE FROM ANY STEP — the shell's copy of Horizon's bar, opened from the session footer.
 * A tag sends the note to a step still ahead tonight; "No tag" leaves it for the recap and next
 * session's Loose ends. Loose ends and Horizon keep their own bars, so the shell hides this there.
 */
export function ParkNoteComposer({
  tags,
  sessionId,
  onClose,
  onParked,
}: {
  tags: ParkedTag[]
  sessionId: string
  onClose: () => void
  onParked: () => void
}) {
  const [text, setText] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const trimmed = text.trim()

  function park(e: FormEvent) {
    e.preventDefault()
    if (saving || !trimmed) return
    setSaving(true)
    setError(null)
    looseEndsApi
      .park(trimmed, { ...(tag ? { stepKey: tag } : {}), sessionId })
      .then(() => onParked())
      .catch((err: unknown) => {
        setError(
          err instanceof ApiSendError && typeof err.body?.message === 'string'
            ? err.body.message
            : "That note didn't park — try again."
        )
        setSaving(false)
      })
  }

  const landsAt = tags.find((t) => t.stepKey === tag)?.label

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card wp-park" data-testid="wp-park" onClick={(e) => e.stopPropagation()} onSubmit={park}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="wp-park-t wf-serif">📌 Park a note</div>
        <input
          ref={inputRef}
          className="wp-pne-in"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={saving}
          // The server's own cap (`parkItem`'s MAX_NOTE).
          maxLength={500}
          placeholder={'“We’re going camping, we need to pack”'}
          aria-label="The note"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="wp-pne-tags" role="group" aria-label="Which step should look at this?">
          {tags.map((t) => (
            <button
              key={t.stepKey}
              type="button"
              className={`wp-pne-tag${tag === t.stepKey ? ' on' : ''}`}
              disabled={saving}
              aria-pressed={tag === t.stepKey}
              onClick={() => setTag(t.stepKey)}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className={`wp-pne-tag${tag === null ? ' on' : ''}`}
            disabled={saving}
            aria-pressed={tag === null}
            onClick={() => setTag(null)}
          >
            No tag
          </button>
        </div>
        <p className="wp-park-says">
          {landsAt ? (
            <>Comes back at <b>{landsAt}</b>, later in this session.</>
          ) : (
            <>No step will raise it. It waits in the recap and at next week&rsquo;s Loose ends.</>
          )}
        </p>
        {error && (
          <p className="wp-pne-err" role="alert">
            {error}
          </p>
        )}
        <div className="wp-pne-acts">
          <button type="submit" className="btn btn-primary wp-pne-act" disabled={saving || !trimmed}>
            Park it
          </button>
          <button type="button" className="btn btn-ghost wp-pne-act" disabled={saving} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
