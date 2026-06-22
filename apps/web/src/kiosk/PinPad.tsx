// PIN entry for a PIN-protected profile. A big touch keypad (kiosk is a
// touchscreen); claims the profile on ✓. Distinguishes a wrong PIN (401) from a
// lockout (429, with a countdown hint) via KioskClaimError.
import { useState } from 'react'
import { kioskApi, KioskClaimError, type KioskProfile } from '../lib/api'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']

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
      setError(err.status === 429 ? `Too many tries. Wait ${err.retryAfter ?? 60}s.` : 'Incorrect PIN.')
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
        <div className="kp-title nk-serif">{profile.name}’s PIN</div>
        <div className="kp-dots" aria-label={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
            <span key={i} className={`kp-dot ${i < pin.length ? 'on' : ''}`} />
          ))}
        </div>
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
