// "Set up this device as a kiosk" — enter the pairing code an admin generated in
// Settings → Sign-in & Security. Segmented 6-box input (auto-advance, uppercase,
// paste), auto-submits when full. On success the device secret is stored and the
// AuthGate re-resolves to the profile picker. Reuses the auth-card chrome.
import { useEffect, useRef, useState } from 'react'
import { kioskApi } from '../lib/api'

const LEN = 6
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function PairDevice({ onCancel }: { onCancel: () => void }) {
  const [chars, setChars] = useState<string[]>(() => Array(LEN).fill(''))
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const code = chars.join('')

  function focus(i: number) {
    refs.current[Math.max(0, Math.min(i, LEN - 1))]?.focus()
  }

  // Typing into a box (also handles a multi-char paste landing in one box).
  function onChange(i: number, raw: string) {
    const v = clean(raw)
    setChars((prev) => {
      const next = [...prev]
      if (!v) {
        next[i] = ''
        return next
      }
      let idx = i
      for (const ch of v.split('')) {
        if (idx >= LEN) break
        next[idx++] = ch
      }
      focus(idx)
      return next
    })
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !chars[i] && i > 0) focus(i - 1)
    else if (e.key === 'ArrowLeft') focus(i - 1)
    else if (e.key === 'ArrowRight') focus(i + 1)
  }

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const text = clean(e.clipboardData.getData('text')).slice(0, LEN)
    if (!text) return
    const next = Array(LEN).fill('')
    text.split('').forEach((ch, idx) => (next[idx] = ch))
    setChars(next)
    focus(text.length)
  }

  async function submit() {
    if (code.length < LEN || busy) return
    setBusy(true)
    setError(null)
    try {
      await kioskApi.pair(code, name.trim() || undefined) // setKioskDevice → picker
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
      setChars(Array(LEN).fill(''))
      focus(0)
    }
  }

  // Auto-submit once all six boxes are filled (OTP-style).
  useEffect(() => {
    if (code.length === LEN && !busy) void submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo nk-serif">N</div>
        <div className="auth-title nk-serif">Set up this device</div>
        <div className="auth-sub">Enter the pairing code from Settings → Sign-in &amp; Security on an admin’s device.</div>
        {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

        <label className="auth-label">Device name (optional)</label>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen" />

        <label className="auth-label" style={{ marginTop: 14 }}>Pairing code</label>
        <div className="pair-code">
          {chars.map((c, i) => (
            <input
              key={i}
              ref={(el) => { refs.current[i] = el }}
              className="pair-box"
              value={c}
              onChange={(e) => onChange(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onPaste={onPaste}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={1}
              aria-label={`Character ${i + 1}`}
              autoFocus={i === 0}
              disabled={busy}
            />
          ))}
        </div>

        <button type="button" className="btn btn-primary auth-submit" disabled={busy || code.length < LEN} onClick={submit}>
          {busy ? 'Pairing…' : 'Pair this device'}
        </button>
        <button type="button" className="kp-cancel" style={{ marginTop: 14 }} onClick={onCancel}>
          ← Back to sign in
        </button>
      </div>
    </div>
  )
}
