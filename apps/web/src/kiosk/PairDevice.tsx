// "Set up this device as a kiosk." Two steps:
//   1) enter the 6-digit pairing code (segmented boxes, auto-submit when full)
//   2) on success, name this kiosk (pre-filled "Kiosk") → enter the profile picker.
// Reuses the auth-card chrome.
import { useEffect, useRef, useState } from 'react'
import { kioskApi } from '../lib/api'

const LEN = 6
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

export function PairDevice({ onCancel }: { onCancel: () => void }) {
  const [step, setStep] = useState<'code' | 'name'>('code')
  if (step === 'code') return <CodeStep onPaired={() => setStep('name')} onCancel={onCancel} />
  return <NameStep />
}

function CodeStep({ onPaired, onCancel }: { onPaired: () => void; onCancel: () => void }) {
  const [chars, setChars] = useState<string[]>(() => Array(LEN).fill(''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const code = chars.join('')

  const focus = (i: number) => refs.current[Math.max(0, Math.min(i, LEN - 1))]?.focus()

  function onChange(i: number, raw: string) {
    const v = clean(raw)
    setChars((prev) => {
      const next = [...prev]
      if (!v) { next[i] = ''; return next }
      let idx = i
      for (const ch of v.split('')) { if (idx >= LEN) break; next[idx++] = ch }
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
      await kioskApi.pair(code) // stores the device; we name it next, then enter
      onPaired()
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
        <img className="auth-logo-img" src="/logo.png" alt="Kinnook" width={96} height={96} />
        <div className="auth-title nk-serif">Set up this device</div>
        <div className="auth-sub">Enter the pairing code from Settings → Sign-in &amp; Security on an admin’s device.</div>
        {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

        <label className="auth-label">Pairing code</label>
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
        {busy && <div className="auth-sub" style={{ marginTop: 14, textAlign: 'center' }}>Pairing…</div>}
        <button type="button" className="kp-cancel" style={{ marginTop: 18 }} onClick={onCancel}>
          ← Back to sign in
        </button>
      </div>
    </div>
  )
}

function NameStep() {
  const [name, setName] = useState('Kiosk')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (busy) return
    setBusy(true)
    const label = name.trim()
    try {
      if (label && label !== 'Kiosk') await kioskApi.setDeviceLabel(label)
    } catch {
      /* naming is best-effort; the default "Kiosk" still applies */
    }
    kioskApi.enterKiosk() // → profile picker
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo-img" src="/logo.png" alt="Kinnook" width={96} height={96} />
        <div className="auth-title nk-serif">Name this kiosk</div>
        <div className="auth-sub">So you can tell your devices apart in Settings.</div>
        <form
          className="auth-form"
          onSubmit={(e) => { e.preventDefault(); void save() }}
        >
          <label className="auth-label">Device name</label>
          <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen" autoFocus />
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Start kiosk'}
          </button>
        </form>
      </div>
    </div>
  )
}
