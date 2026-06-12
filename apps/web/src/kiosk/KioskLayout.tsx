import { Outlet } from 'react-router'
import { Rail } from './components/Rail'
import { Topbar } from './components/Topbar'
import { OfflineBanner } from './components/OfflineBanner'
import { TopbarSlotProvider } from './topbar-slot'

// The persistent kiosk chrome (responsive, fills the viewport). The active
// screen renders in the Outlet and can fill the topbar's right slot.
export function KioskLayout() {
  return (
    <TopbarSlotProvider>
      <div className="nk-kiosk nk">
        <Rail />
        <div className="kiosk-main">
          <OfflineBanner />
          <Topbar />
          <Outlet />
        </div>
      </div>
    </TopbarSlotProvider>
  )
}
