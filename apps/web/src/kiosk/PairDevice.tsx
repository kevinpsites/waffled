// "Set up this device as a kiosk" — enter the pairing code an admin generated in
// Settings → Devices. On success the device secret is stored and the AuthGate
// re-resolves to the profile picker. Reuses the auth-card chrome.
import { useState, type FormEvent } from 'react'
import { kioskApi } from '../lib/api'

export function PairDevice({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await kioskApi.pair(code) // setKioskDevice fires nook:auth-changed → picker
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo nk-serif">N</div>
        <div className="auth-title nk-serif">Set up this device</div>
        <div className="auth-sub">Enter the pairing code from Settings → Devices on an admin’s device.</div>
        {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
        <form onSubmit={submit} className="auth-form">
          <label className="auth-label">Pairing code</label>
          <input
            className="auth-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. K7P2QW"
            autoCapitalize="characters"
            autoFocus
            required
          />
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy || code.trim().length < 4}>
            {busy ? 'Pairing…' : 'Pair this device'}
          </button>
        </form>
        <button type="button" className="kp-cancel" style={{ marginTop: 14 }} onClick={onCancel}>
          ← Back to sign in
        </button>
      </div>
    </div>
  )
}
