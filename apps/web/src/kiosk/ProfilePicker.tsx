// The kiosk's resting state: a Netflix-style profile chooser. Tap a profile to
// claim a real, person-scoped session (PIN-gated if that person set one). Shown by
// AuthGate whenever the device is paired (kiosk mode) and no profile is active.
import { useEffect, useState } from 'react'
import { kioskApi, type KioskProfile } from '../lib/api'
import { PinPad } from './PinPad'
import '../styles/kiosk-profiles.css'

export function ProfilePicker() {
  const [profiles, setProfiles] = useState<KioskProfile[] | null>(null)
  const [deviceLabel, setDeviceLabel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pinFor, setPinFor] = useState<KioskProfile | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    kioskApi
      .profiles()
      .then((d) => {
        if (!alive) return
        setProfiles(d.profiles)
        setDeviceLabel(d.deviceLabel)
      })
      .catch(() => alive && setError('Couldn’t load profiles. Check the connection.'))
    return () => {
      alive = false
    }
  }, [])

  async function pick(p: KioskProfile) {
    if (p.hasPin) {
      setPinFor(p)
      return
    }
    setBusyId(p.id)
    try {
      await kioskApi.claim(p.id) // setSession → AuthGate flips to the app
    } catch {
      setError('Couldn’t switch to that profile.')
      setBusyId(null)
    }
  }

  if (pinFor) return <PinPad profile={pinFor} onCancel={() => setPinFor(null)} />

  return (
    <div className="kp-screen">
      <div className="kp-head">
        <div className="kp-logo nk-serif">N</div>
        <div className="kp-title nk-serif">Who’s using Nook?</div>
        <div className="kp-sub">Tap your profile to continue.</div>
      </div>
      {error && <div className="kp-error">{error}</div>}
      <div className="kp-grid">
        {(profiles ?? []).map((p) => (
          <button key={p.id} className="kp-tile" onClick={() => pick(p)} disabled={!!busyId} aria-label={p.name}>
            <span className="kp-av" style={{ background: p.colorHex ? `${p.colorHex}22` : 'var(--panel)' }}>
              {p.avatarEmoji ?? '🙂'}
            </span>
            <span className="kp-name">
              {p.name}
              {p.hasPin && <span className="kp-lock" title="PIN protected"> 🔒</span>}
            </span>
          </button>
        ))}
        {profiles && profiles.length === 0 && <div className="kp-empty">No profiles are shown on the kiosk yet.</div>}
      </div>
      {deviceLabel && <div className="kp-device">🖥️ {deviceLabel}</div>}
    </div>
  )
}
