import { KioskStage } from './KioskStage'
import { Rail } from './components/Rail'
import { Topbar } from './components/Topbar'
import { Today } from './Today'

// The counter kiosk surface — the always-on Today dashboard.
export function Kiosk() {
  return (
    <KioskStage>
      <div className="nk-kiosk nk">
        <Rail active="home" />
        <div className="kiosk-main">
          <Topbar />
          <Today />
        </div>
      </div>
    </KioskStage>
  )
}
