import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { Rail } from './components/Rail'
import { Topbar } from './components/Topbar'
import { OfflineBanner } from './components/OfflineBanner'
import { UpdateModal } from './components/UpdateModal'
import { TopbarSlotProvider } from './topbar-slot'
import { Icon } from './icons'
import { SCREENS, SETTINGS } from './nav'
import '../styles/kiosk-profiles.css'

// The persistent kiosk chrome (responsive, fills the viewport). The active
// screen renders in the Outlet and can fill the topbar's right slot. (Idle /
// screensaver / keep-awake live in KioskDisplay, which wraps the whole app.)
export function KioskLayout() {
  const [navOpen, setNavOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const location = useLocation()
  const active = [...SCREENS, SETTINGS]
    .filter((screen) => screen.path === '/' ? location.pathname === '/' : location.pathname.startsWith(screen.path))
    .sort((a, b) => b.path.length - a.path.length)[0]

  useEffect(() => setNavOpen(false), [location.pathname])
  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  return (
    <TopbarSlotProvider>
      <div className="wf-kiosk wf">
        <header className="mobile-header">
          <Link to="/" className="mobile-brand" aria-label="Waffled home">
            <img src="/logo.png" alt="" />
            <span>{active?.label ?? 'Waffled'}</span>
          </Link>
          <button
            ref={triggerRef}
            type="button"
            className="mobile-menu-button"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-controls="primary-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name={navOpen ? 'close' : 'menu'} />
          </button>
        </header>
        <button
          type="button"
          className={`mobile-nav-scrim${navOpen ? ' open' : ''}`}
          aria-label="Close navigation"
          tabIndex={navOpen ? 0 : -1}
          onClick={() => setNavOpen(false)}
        />
        <Rail mobileOpen={navOpen} onNavigate={() => setNavOpen(false)} />
        <div className="kiosk-main">
          <OfflineBanner />
          <Topbar />
          <Outlet />
        </div>
        <UpdateModal />
      </div>
    </TopbarSlotProvider>
  )
}
