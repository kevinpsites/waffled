import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './styles/nook.css'
import './styles/kiosk.css'
import { Kiosk } from './kiosk/Kiosk'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Kiosk />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
)
