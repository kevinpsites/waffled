import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/nook.css'
import './styles/kiosk.css'
import './styles/calendar.css'
import { KioskRoutes } from './kiosk/routes'
import { AuthGate } from './kiosk/AuthGate'
import { registerServiceWorker } from './lib/pwa'
import { connectPowerSync } from './lib/powersync/db'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate>
        <KioskRoutes />
      </AuthGate>
    </BrowserRouter>
  </StrictMode>
)

registerServiceWorker()

// Start realtime replication (best-effort; the app works over REST without it).
void connectPowerSync()
