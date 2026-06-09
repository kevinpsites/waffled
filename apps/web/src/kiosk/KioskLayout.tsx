import { Outlet } from 'react-router'
import { Rail } from './components/Rail'
import { Topbar } from './components/Topbar'

// The persistent kiosk chrome (responsive, fills the viewport). The active
// screen renders in the Outlet.
export function KioskLayout() {
  return (
    <div className="nk-kiosk nk">
      <Rail />
      <div className="kiosk-main">
        <Topbar />
        <Outlet />
      </div>
    </div>
  )
}
