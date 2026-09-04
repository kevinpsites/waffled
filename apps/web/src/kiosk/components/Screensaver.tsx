// Shared full-screen screensaver. Always shows a big clock + date, plus real weather
// and the next event when available. With content='photos' and photos present, it
// cycles them as the background (otherwise a calm dark gradient — "clock & weather").
// Used both by the Photos manual "Play screensaver" and the kiosk idle screensaver.
import { useEffect, useRef, useState } from 'react'
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

function signedMediaCacheKey(raw: string): string | null {
  try {
    const url = new URL(raw, window.location.origin)
    if (!url.searchParams.has('expires') || !url.searchParams.has('sig')) return null
    url.searchParams.delete('expires')
    url.searchParams.delete('sig')
    return url.toString()
  } catch {
    return null
  }
}

// Keep the URL that actually loaded until the browser rejects it. API refreshes rotate
// the bearer signature, but changing <img src> immediately would defeat the browser's
// decoded-image cache and re-download every full-resolution slide. On a 403/error we
// first retry the newest already-fetched signature, or ask the parent to fetch one.
function ScreensaverPhoto({ url, className, loadedUrls, onMediaExpired }: {
  url: string
  className: string
  loadedUrls: Map<string, string>
  onMediaExpired?: () => void
}) {
  const cacheKey = signedMediaCacheKey(url)
  const [src, setSrc] = useState(() => cacheKey ? loadedUrls.get(cacheKey) ?? url : url)
  const keyRef = useRef(cacheKey)
  const latestRef = useRef(url)
  const awaitingFreshRef = useRef(false)
  const rejectedRef = useRef(new Set<string>())

  useEffect(() => {
    latestRef.current = url
    if (keyRef.current !== cacheKey) {
      keyRef.current = cacheKey
      awaitingFreshRef.current = false
      rejectedRef.current.clear()
      setSrc(cacheKey ? loadedUrls.get(cacheKey) ?? url : url)
    } else if (awaitingFreshRef.current && url !== src) {
      awaitingFreshRef.current = false
      setSrc(url)
    }
  }, [cacheKey, loadedUrls, src, url])

  return <img className={className} src={src} alt="" onLoad={() => {
    if (cacheKey) loadedUrls.set(cacheKey, src)
  }} onError={() => {
    if (!cacheKey || rejectedRef.current.has(src)) return
    rejectedRef.current.add(src)
    if (loadedUrls.get(cacheKey) === src) loadedUrls.delete(cacheKey)
    if (latestRef.current !== src) {
      setSrc(latestRef.current)
    } else {
      awaitingFreshRef.current = true
      onMediaExpired?.()
    }
  }} />
}

export function Screensaver({
  content,
  photos,
  weather,
  nextEvent,
  timezone,
  intervalSeconds = 10,
  bare = false,
  onMediaExpired,
  onWake,
}: {
  content: 'photos' | 'clock'
  photos: Photo[]
  weather: Weather | null
  nextEvent: AgendaEvent | null
  timezone?: string
  intervalSeconds?: number
  // bare = a pure photo slideshow (no clock / weather / next-event / caption
  // overlays). Used by the manual "Play" from the Photos screen; the idle kiosk
  // screensaver leaves it false to keep the clock + weather chrome.
  bare?: boolean
  onMediaExpired?: () => void
  onWake: () => void
}) {
  const [now, setNow] = useState(() => new Date())
  const [idx, setIdx] = useState(0)
  const [prevIdx, setPrevIdx] = useState(0)
  // Preserve each successfully loaded signed URL by stable storage path while this
  // screensaver is mounted, including when a slide cycles out of the React tree.
  const loadedMediaUrls = useRef(new Map<string, string>())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const photoMode = content === 'photos' && photos.length > 0
  useEffect(() => {
    if (!photoMode) return
    const ms = Math.max(3, intervalSeconds) * 1000
    const t = setInterval(() => {
      // advance, remembering the photo we're leaving so the top layer can
      // crossfade over it (no jarring hard cut).
      setIdx((i) => {
        setPrevIdx(i)
        return (i + 1) % photos.length
      })
    }, ms)
    return () => clearInterval(t)
  }, [photoMode, photos.length, intervalSeconds])

  const photo = photoMode ? photos[idx % photos.length] : null
  const prevPhoto = photoMode ? photos[prevIdx % photos.length] : null
  const showChrome = !bare
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined }).replace(/\s?[AP]M$/i, '')
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: timezone || undefined })
  const wx = weather?.configured && weather.tempF != null ? `${weather.emoji ?? ''} ${weather.tempF}°${weather.label ? ` · ${weather.label}` : ''}`.trim() : null
  const evTime = nextEvent && !nextEvent.allDay
    ? new Date(nextEvent.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone || undefined }).replace(/\s?[AP]M$/i, '')
    : null
  const bg = photo ? tileBg(photo) : 'linear-gradient(135deg, #2b2b2b, #161616)'

  return (
    <div className="ph-saver" style={{ background: bg }} onClick={onWake} role="button" aria-label="Wake screensaver">
      {/* base layer = the photo we're leaving; top layer fades in over it */}
      {prevPhoto?.imageUrl && <ScreensaverPhoto url={prevPhoto.imageUrl} className="ph-saver-img" loadedUrls={loadedMediaUrls.current} onMediaExpired={onMediaExpired} />}
      {photo?.imageUrl && <ScreensaverPhoto key={idx} url={photo.imageUrl} className="ph-saver-img ph-saver-img-top" loadedUrls={loadedMediaUrls.current} onMediaExpired={onMediaExpired} />}
      {showChrome && <div className="ph-saver-scrim" />}
      {showChrome && (
        <div className="ph-saver-clock">
          <div className="wf-serif ph-saver-time">{time}</div>
          <div className="ph-saver-date">{date}{wx ? ` · ${wx}` : ''}</div>
        </div>
      )}
      {photo && !photo.imageUrl && <div key={idx} className="ph-saver-hero ph-saver-img-top">{photo.emoji ?? '🖼️'}</div>}
      {showChrome && nextEvent && (
        <div className="ph-saver-next">
          Next: {nextEvent.title}{evTime ? ` · ${evTime}` : ''}
        </div>
      )}
      {showChrome && photo && (photo.memory || photo.caption) && (
        <div className="ph-saver-meta">
          <div className="wf-serif">{photo.memory ?? photo.caption}</div>
        </div>
      )}
      <div className="ph-saver-wake">Tap anywhere to wake</div>
    </div>
  )
}
