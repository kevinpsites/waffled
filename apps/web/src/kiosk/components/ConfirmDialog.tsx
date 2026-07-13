// In-app confirm/prompt dialog — replaces native window.confirm/prompt/alert so
// destructive and input actions match the app's look. With `input`, it doubles as
// a prompt (e.g. rename) and passes the entered value to onConfirm.
import { useState, type FormEvent } from 'react'

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  input,
  onConfirm,
  onClose,
}: {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  input?: { label?: string; placeholder?: string; initial?: string }
  onConfirm: (value?: string) => void | Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(input?.initial ?? '')
  const [busy, setBusy] = useState(false)

  async function confirm(e?: FormEvent) {
    e?.preventDefault()
    if (busy) return
    if (input && !value.trim()) return
    setBusy(true)
    try {
      await onConfirm(input ? value.trim() : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={confirm} style={{ maxWidth: 400 }}>
        <div className="wf-serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: message || input ? 8 : 16 }}>{title}</div>
        {message && <div className="tiny muted" style={{ fontWeight: 600, marginBottom: input ? 14 : 18, lineHeight: 1.4 }}>{message}</div>}
        {input && (
          <label className="field" style={{ marginBottom: 16 }}>
            {input.label && <span>{input.label}</span>}
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={input.placeholder} autoFocus />
          </label>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button
            type="submit"
            className="btn btn-primary"
            style={danger ? { background: 'var(--danger)', borderColor: 'transparent' } : undefined}
            disabled={busy || (!!input && !value.trim())}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
