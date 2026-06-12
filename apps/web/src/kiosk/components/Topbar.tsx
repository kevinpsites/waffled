import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { useTopbarSlots } from '../topbar-slot'
import { useHousehold } from '../../lib/api'
import { CaptureBar } from './CaptureBar'

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatDate(d: Date, tz?: string): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', timeZone: tz || undefined })
}

function formatTime(d: Date, tz?: string): string {
  // 12-hour without the AM/PM suffix (matches the design), in the household tz
  return d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz || undefined })
    .replace(/\s?[AP]M$/i, '')
}

export function Topbar() {
  const now = useNow()
  const { right, full } = useTopbarSlots()
  const { household } = useHousehold()
  const tz = household?.timezone
  if (full) return <div className="topbar">{full}</div>
  return (
    <div className="topbar">
      <div className="tb-date nk-serif">{formatDate(now, tz)}</div>
      <div className="tb-time">{formatTime(now, tz)}</div>
      <div className="tb-wx">
        <Icon name="cloud" />
        60°
      </div>
      <div className="tb-right">{right ?? <CaptureBar />}</div>
    </div>
  )
}
