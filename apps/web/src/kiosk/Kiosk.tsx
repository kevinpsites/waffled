import { KioskStage } from './KioskStage'
import { Rail } from './components/Rail'
import { Topbar } from './components/Topbar'

// The counter kiosk surface. Today dashboard cards land in the next chunk.
export function Kiosk() {
  return (
    <KioskStage>
      <div className="nk-kiosk nk">
        <Rail active="home" />
        <div className="kiosk-main">
          <Topbar />
          <div style={{ flex: 1 }} />
        </div>
      </div>
    </KioskStage>
  )
}
