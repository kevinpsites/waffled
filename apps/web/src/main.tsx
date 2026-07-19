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

// Apply the saved (or OS-matched) theme before first paint to avoid a flash.
initTheme()

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
