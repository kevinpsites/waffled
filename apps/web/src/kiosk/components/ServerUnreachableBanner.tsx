import { useState } from 'react'
import { useOnline } from '../../lib/pwa'
import { probeServerNow, useServerReachability } from '../../lib/api/reachability'

// One copy, two surfaces: this strip and the AuthGate's pre-login screen.
export const UNREACHABLE_HEADLINE = 'Can’t reach the Waffled server'
export const UNREACHABLE_HINT =
  'On the Mac that runs Waffled, click the waffle icon in the menu bar and choose Start Waffled. On a Docker install, run ./waffled status.'

// The strip that explains an empty screen when the SERVER is gone but the device is
// fine — same quiet shape as OfflineBanner, and it defers to that one, which describes
// the more fundamental problem. Mounted at the app root (main.tsx) rather than in
// KioskLayout so it also covers the login / setup / picker screens; fixed rather than
// in-flow because `.wf-kiosk` is a 100dvh grid that a preceding sibling would push off
// the bottom of the viewport.
export function ServerUnreachableBanner() {
  const reachability = useServerReachability()
  // The device's link, not the debounced version of it: while the device is offline
  // this banner has nothing true to say, and it must stop saying it at once.
  const deviceOnline = useOnline()
  const [checking, setChecking] = useState(false)
  if (reachability === 'reachable' || !deviceOnline) return null

  async function retry() {
    setChecking(true)
    try {
      await probeServerNow()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="unreachable-banner" role="status">
      <span className="unreachable-line">⚠️ {UNREACHABLE_HEADLINE} — it may be stopped or asleep. Retrying…</span>
      <button type="button" className="btn btn-ghost unreachable-retry" onClick={() => void retry()} disabled={checking}>
        {checking ? 'Checking…' : 'Retry'}
      </button>
      <span className="unreachable-hint">{UNREACHABLE_HINT}</span>
    </div>
  )
}
