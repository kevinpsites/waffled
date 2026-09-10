import { useEffect, useRef, useState } from 'react'
import { useOnline, useSustainedOffline } from '../../lib/pwa'
import { probeServerNow, useServerReachability } from '../../lib/api/reachability'

// One copy, two surfaces: this strip and the AuthGate's pre-login screen.
export const UNREACHABLE_HEADLINE = 'Can’t reach the Waffled server'
/** Two lines of copy at the kiosk's font sizes; used until the strip has been laid out. */
const FALLBACK_HEIGHT_PX = 56
export const UNREACHABLE_HINT =
  'On the Mac that runs Waffled, click the waffle icon in the menu bar and choose Start Waffled. On a Docker install, run ./waffled status.'

export const DEVICE_OFFLINE_LINE = 'You’re offline — reconnecting…'

// The strip that explains an empty screen when the SERVER is gone but the device is
// fine. Mounted at the app root (main.tsx) rather than in KioskLayout so it also
// covers the login / setup / picker screens; fixed rather than in-flow because
// `.wf-kiosk` is a 100dvh grid that a preceding sibling would push off the bottom.
//
// The handoff to OfflineBanner is by copy, not by hiding: that banner waits out a
// 10s grace, so vanishing the instant the link drops left ten seconds with nothing
// on screen. The strip holds its space and tells the device's story until the other
// banner is ready to take it over.
export function ServerUnreachableBanner() {
  const reachability = useServerReachability()
  // The link itself, and the debounced version of it: the first decides what this
  // says, the second decides when OfflineBanner has the story instead.
  const deviceOnline = useOnline()
  const offlineBannerUp = useSustainedOffline()
  const [checking, setChecking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const shown = reachability === 'unreachable' && !offlineBannerUp

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

  // Nothing about starting the server is true or useful while the device has no
  // link — no Retry to press, no hint to follow.
  if (!deviceOnline) {
    return (
      <div className="unreachable-banner" role="status" ref={ref}>
        <span className="unreachable-line">⚡ {DEVICE_OFFLINE_LINE}</span>
      </div>
    )
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
