import { useEffect, useRef, useState } from 'react'
import { useTopbarSlots } from '../topbar-slot'
import { useHousehold, useWeather, type Weather } from '../../lib/api'
import { CaptureBar } from './CaptureBar'

// Weather widget with a hover/tap popover that says where the reading comes from.
function WeatherWidget({ wx }: { wx: Weather }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])
  return (
    <div className="tb-wx-wrap" ref={ref}>
      <button
        type="button"
        className="tb-wx"
        aria-label="Weather details"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <span aria-hidden="true">{wx.emoji}</span>
        {wx.tempF}°
      </button>
      <div className={`tb-wx-pop ${open ? 'open' : ''}`} role="tooltip">
        <div className="tb-wx-pop-t">
          {wx.emoji} {wx.tempF}°{wx.label ? ` · ${wx.label}` : ''}
        </div>
        <div className="tb-wx-pop-s">{wx.location ? `Weather for ${wx.location}` : 'Weather'}</div>
        <div className="tb-wx-pop-s muted">via Open-Meteo · change in Settings → Location</div>
      </div>
    </div>
  )
}

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
  const wx = useWeather()
  const tz = household?.timezone
  if (full) return <div className="topbar">{full}</div>
  return (
    <div className="topbar">
      <div className="tb-date nk-serif">{formatDate(now, tz)}</div>
      <div className="tb-time">{formatTime(now, tz)}</div>
      {wx?.configured && wx.tempF != null && <WeatherWidget wx={wx} />}
      <div className="tb-right">{right ?? <CaptureBar />}</div>
    </div>
  )
}
