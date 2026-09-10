import { useEffect, useRef, useState } from 'react'
import { useOnline } from '../../lib/pwa'
import { probeServerNow, useServerReachability } from '../../lib/api/reachability'

// One copy, two surfaces: this strip and the AuthGate's pre-login screen.
export const UNREACHABLE_HEADLINE = 'Can’t reach the Waffled server'
/** Two lines of copy at the kiosk's font sizes; used until the strip has been laid out. */
const FALLBACK_HEIGHT_PX = 56
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
  const ref = useRef<HTMLDivElement>(null)
  const shown = reachability === 'unreachable' && deviceOnline

  // The strip floats over the chrome, so the app has to be pushed down by exactly
  // its height or it swallows whatever is at the top of the screen (the mobile
  // header, a modal's close button). kiosk.css owns the layout; this owns the
  // measurement, because the copy wraps to two or three lines on a phone.
  useEffect(() => {
    if (!shown) return
    const root = document.documentElement
    root.classList.add('server-unreachable')
    const measure = () =>
      root.style.setProperty('--unreachable-h', `${ref.current?.offsetHeight || FALLBACK_HEIGHT_PX}px`)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (ref.current) observer?.observe(ref.current)
    return () => {
      observer?.disconnect()
      root.classList.remove('server-unreachable')
      root.style.removeProperty('--unreachable-h')
    }
  }, [shown])

  if (!shown) return null

  async function retry() {
    setChecking(true)
    try {
      await probeServerNow()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="unreachable-banner" role="status" ref={ref}>
      <span className="unreachable-line">⚠️ {UNREACHABLE_HEADLINE} — it may be stopped or asleep. Retrying…</span>
      <button type="button" className="btn btn-ghost unreachable-retry" onClick={() => void retry()} disabled={checking}>
        {checking ? 'Checking…' : 'Retry'}
      </button>
      <span className="unreachable-hint">{UNREACHABLE_HINT}</span>
    </div>
  )
}
