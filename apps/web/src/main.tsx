import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/nook.css'
import './styles/kiosk.css'
import { KioskRoutes } from './kiosk/routes'
import { registerServiceWorker } from './lib/pwa'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <KioskRoutes />
    </BrowserRouter>
  </StrictMode>
)

registerServiceWorker()
