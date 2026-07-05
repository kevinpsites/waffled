// PIN entry for a PIN-protected profile. A big touch keypad (kiosk is a
// touchscreen); claims the profile on ✓. Distinguishes a wrong PIN (401) from a
// lockout (429, with a countdown hint) via KioskClaimError.
import { useState } from 'react'
import { kioskApi, KioskClaimError, type KioskProfile } from '../lib/api'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']

function wrongMsg(triesLeft?: number): string {
  if (triesLeft && triesLeft > 0) return `Incorrect PIN — ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left`
  return 'Incorrect PIN.'
}
function lockedMsg(seconds?: number): string {
  const s = seconds ?? 30
  if (s >= 60) return `Too many tries. Try again in ${Math.ceil(s / 60)} min.`
  return `Too many tries. Try again in ${s}s.`
}

export function PinPad({ profile, onCancel }: { profile: KioskProfile; onCancel: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (pin.length < 4 || busy) return
    setBusy(true)
    setError(null)
    try {
      await kioskApi.claim(profile.id, pin) // success → setSession → AuthGate flips
    } catch (e) {
      const err = e as KioskClaimError
      setError(err.status === 429 ? lockedMsg(err.retryAfter) : wrongMsg(err.triesLeft))
      setPin('')
      setBusy(false)
    }
  }

  function press(k: string) {
    if (busy) return
    if (k === 'del') return setPin((p) => p.slice(0, -1))
    if (k === 'ok') return void submit()
    setPin((p) => (p.length >= 8 ? p : p + k))
  }

  return (
    <div className="kp-screen">
      <div className="kp-head">
        <span className="kp-av kp-av-lg" style={{ background: profile.colorHex ? `${profile.colorHex}22` : 'var(--panel)' }}>
          {profile.avatarEmoji ?? '🙂'}
        </span>
        <div className="kp-title wf-serif">{profile.name}’s PIN</div>
        <div className="kp-dots" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: pin.length }).map((_, i) => (
            <span key={i} className="kp-dot on" />
          ))}
          {pin.length === 0 && <span className="kp-dots-hint">Enter your PIN</span>}
        </div>
        <div className="kp-cap">4–8 digits</div>
        {error && <div className="kp-error">{error}</div>}
      </div>
      <div className="kp-pad">
        {KEYS.map((k) => (
          <button
            key={k}
            className={`kp-key ${k === 'ok' ? 'kp-key-ok' : ''} ${k === 'del' ? 'kp-key-del' : ''}`}
            onClick={() => press(k)}
            disabled={busy || (k === 'ok' && pin.length < 4)}
          >
            {k === 'del' ? '⌫' : k === 'ok' ? '✓' : k}
          </button>
        ))}
      </div>
      <button className="kp-cancel" onClick={onCancel} disabled={busy}>
        ← Back to profiles
      </button>
    </div>
  )
}
