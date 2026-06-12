import { useOnline } from '../../lib/pwa'

// A quiet strip the kiosk shows when the network drops. The service worker keeps
// serving the last-known state, so this just tells the family what they're seeing.
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      ⚡ Offline — showing the last saved view. Changes will wait until you’re back online.
    </div>
  )
}
