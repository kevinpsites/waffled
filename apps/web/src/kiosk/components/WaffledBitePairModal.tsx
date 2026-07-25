import { useEffect, useRef, useState } from 'react'
import { waffledBitesApi } from '../../lib/api'

// Mints a pairing code for this kid, shows it, and polls until the device (once
// someone types the code on it) claims it — mirroring the kiosk "pair a device"
// sheet's shape, but scoped to a single child rather than a household picker.
export function WaffledBitePairModal({
  personId,
  personName,
  onClose,
  onPaired,
}: {
  personId: string
  personName: string
  onClose: () => void
  onPaired: () => void
}) {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    waffledBitesApi
      .mintPairingCode(personId, `${personName}'s Waffled-Bite`)
      .then((r) => alive && setCode(r.code))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [personId, personName])

  useEffect(() => {
    if (!code) return
    pollRef.current = setInterval(() => {
      waffledBitesApi.get(personId).then((device) => {
        if (device) {
          if (pollRef.current) clearInterval(pollRef.current)
          onPaired()
        }
      })
    }, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [code, personId, onPaired])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380, textAlign: 'center' }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          Pair {personName}'s Waffled-Bite
        </div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 18 }}>
          Turn on the Waffled-Bite, connect it to Wi-Fi, then enter this code when it asks.
        </div>
        {error && <div className="muted tiny" style={{ fontWeight: 600 }}>Couldn't start pairing — try again.</div>}
        {!error && !code && <div className="muted tiny" style={{ fontWeight: 600 }}>Generating a code…</div>}
        {code && (
          <>
            <div
              style={{
                fontFamily: 'monospace', fontSize: 32, fontWeight: 800, letterSpacing: '0.12em',
                background: 'var(--panel)', borderRadius: 'var(--r-lg)', padding: '18px 12px', margin: '0 0 16px',
              }}
            >
              {code}
            </div>
            <div className="tiny muted" style={{ fontWeight: 600 }}>Waiting for the Waffled-Bite…</div>
          </>
        )}
        <button type="button" className="btn btn-ghost" style={{ marginTop: 18, width: '100%', justifyContent: 'center' }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
