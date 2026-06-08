import { useEffect, useState } from 'react'
import { Icon } from '../icons'

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })
}

function formatTime(d: Date): string {
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The AI "Add anything…" capture bar (static placeholder until 6.6).
function AiBar() {
  return (
    <div className="ai-bar" style={{ flex: 1, maxWidth: 520 }}>
      <div className="ai-spark">
        <Icon name="spark" />
      </div>
      <div className="ph">Add anything… “Soccer Tue 4pm for Wally”</div>
      <div className="mic">
        <Icon name="mic" />
      </div>
    </div>
  )
}

export function Topbar() {
  const now = useNow()
  return (
    <div className="topbar">
      <div className="tb-date nk-serif">{formatDate(now)}</div>
      <div className="tb-time">{formatTime(now)}</div>
      <div className="tb-wx">
        <Icon name="cloud" />
        60°
      </div>
      <div className="tb-right">
        <AiBar />
      </div>
    </div>
  )
}
