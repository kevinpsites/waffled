import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/nook.css'
import './styles/kiosk.css'
import { KioskRoutes } from './kiosk/routes'
import { registerServiceWorker } from './lib/pwa'
import { connectPowerSync } from './lib/powersync/db'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <KioskRoutes />
    </BrowserRouter>
  </StrictMode>
)

registerServiceWorker()

// Start realtime replication (best-effort; the app works over REST without it).
void connectPowerSync()
