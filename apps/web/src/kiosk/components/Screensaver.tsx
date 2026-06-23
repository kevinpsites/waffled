// Shared full-screen screensaver. Always shows a big clock + date, plus real weather
// and the next event when available. With content='photos' and photos present, it
// cycles them as the background (otherwise a calm dark gradient — "clock & weather").
// Used both by the Photos manual "Play screensaver" and the kiosk idle screensaver.
import { useEffect, useState } from 'react'
import type { Photo, Weather, AgendaEvent } from '../../lib/api'
import '../../styles/photos.css'

// Pick + order the photos a screensaver should play, given the household display
// config. Pure: never mutates the input list.
export function screensaverPhotos(
  photos: Photo[],
  cfg: { photoSource?: string; photoAlbum?: string | null; photoShuffle?: boolean },
): Photo[] {
  let out: Photo[]
  if (cfg.photoSource === 'favorites') {
    out = photos.filter((p) => p.isFavorite)
  } else if (cfg.photoSource === 'album') {
    out = cfg.photoAlbum ? photos.filter((p) => p.memory === cfg.photoAlbum) : photos.slice()
  } else {
    out = photos.slice()
  }
  if (cfg.photoShuffle) {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
  }
  return out
}

function shade(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const f = 0.78
  const r = Math.round(((n >> 16) & 255) * f)
  const g = Math.round(((n >> 8) & 255) * f)
  const b = Math.round((n & 255) * f)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}
const tileBg = (p: { colorHex?: string | null }) => {
  const c = p.colorHex ?? '#7fc1e8'
  return `linear-gradient(135deg, ${c}, ${shade(c)})`
}

export function Screensaver({
  content,
  photos,
  weather,
  nextEvent,
  timezone,
  intervalSeconds = 10,
  onWake,
}: {
  content: 'photos' | 'clock'
  photos: Photo[]
  weather: Weather | null
  nextEvent: AgendaEvent | null
  timezone?: string
  intervalSeconds?: number
  onWake: () => void
}) {
  const [now, setNow] = useState(() => new Date())
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const photoMode = content === 'photos' && photos.length > 0
  useEffect(() => {
    if (!photoMode) return
    const ms = Math.max(3, intervalSeconds) * 1000
    const t = setInterval(() => setIdx((i) => (i + 1) % photos.length), ms)
    return () => clearInterval(t)
  }, [photoMode, photos.length, intervalSeconds])

  const photo = photoMode ? photos[idx % photos.length] : null
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined }).replace(/\s?[AP]M$/i, '')
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone || undefined })
  const wx = weather?.configured && weather.tempF != null ? `${weather.emoji ?? ''} ${weather.tempF}°${weather.label ? ` · ${weather.label}` : ''}`.trim() : null
  const evTime = nextEvent && !nextEvent.allDay
    ? new Date(nextEvent.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined }).replace(/\s?[AP]M$/i, '')
    : null
  const bg = photo ? tileBg(photo) : 'linear-gradient(135deg, #2b2b2b, #161616)'

  return (
    <div className="ph-saver" style={{ background: bg }} onClick={onWake} role="button" aria-label="Wake screensaver">
      {photo?.imageUrl && <img className="ph-saver-img" src={photo.imageUrl} alt="" />}
      <div className="ph-saver-scrim" />
      <div className="ph-saver-clock">
        <div className="nk-serif ph-saver-time">{time}</div>
        <div className="ph-saver-date">{date}{wx ? ` · ${wx}` : ''}</div>
      </div>
      {photo && !photo.imageUrl && <div className="ph-saver-hero">{photo.emoji ?? '🖼️'}</div>}
      {nextEvent && (
        <div className="ph-saver-next">
          Next: {nextEvent.title}{evTime ? ` · ${evTime}` : ''}
        </div>
      )}
      {photo && (photo.memory || photo.caption) && (
        <div className="ph-saver-meta">
          <div className="nk-serif">{photo.memory ?? photo.caption}</div>
        </div>
      )}
      <div className="ph-saver-wake">Tap anywhere to wake</div>
    </div>
  )
}
