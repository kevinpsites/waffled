import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/waffled.css'
import './styles/kiosk.css'
import './styles/calendar.css'
import { KioskRoutes } from './kiosk/routes'
import { AuthGate } from './kiosk/AuthGate'
import { KioskDisplay } from './kiosk/KioskDisplay'
import { registerServiceWorker } from './lib/pwa'
import { connectPowerSync } from './lib/powersync/db'
import { initTheme } from './lib/theme'
import { applyEventStyle } from './lib/display'

// Apply the saved (or OS-matched) theme before first paint to avoid a flash.
initTheme()
// Same for event chips: stamp the default style before the household loads, so
// the calendar never flashes tinted chips on its way to solid. The Topbar
// corrects this once /api/household resolves (and on every household change).
applyEventStyle('solid')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <KioskDisplay>
        <AuthGate>
          <KioskRoutes />
        </AuthGate>
      </KioskDisplay>
    </BrowserRouter>
  </StrictMode>
)

registerServiceWorker()

// Start realtime replication (best-effort; the app works over REST without it).
void connectPowerSync()
