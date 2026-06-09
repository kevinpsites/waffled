import { useEffect, useMemo, useState } from 'react'
import { api, usePhotos, type Photo } from '../lib/api'
import { Icon } from './icons'
import { useTopbarRight } from './topbar-slot'
import { PhotoAdd } from './components/PhotoAdd'
import { PhotoDetail } from './components/PhotoDetail'
import '../styles/photos.css'

// Photos home — the family wall (matches photos.png): a "NEW MEMORY" banner over
// a masonry wall of tiles, each an <img> or an emoji-on-gradient tile (Nook has
// no blob storage yet, so emoji tiles are the intended fallback — the mock itself
// renders colored emoji tiles). Tapping a tile opens the detail; the topbar adds
// "Play screensaver" + "Add photos"; the screensaver is a full-screen takeover.

function weekdayOf(photo: Photo): string {
  return new Date(photo.takenAt ?? photo.createdAt).toLocaleDateString('en-US', { weekday: 'long' })
}

function tileBg(photo: Photo): string {
  const c = photo.colorHex ?? '#7fc1e8'
  return `linear-gradient(135deg, ${c}, ${shade(c)})`
}

// Recreate the mock's masonry rhythm deterministically: the 1st tile is wide,
// the 3rd is tall, then every 6th wide — so a fresh wall reads like photos.png.
function spanFor(i: number): string {
  if (i === 0) return 'wide'
  if (i === 2) return 'tall'
  if (i % 6 === 5) return 'wide'
  return ''
}

function PhotoTile({ photo, span, onOpen, onDelete }: { photo: Photo; span: string; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className={`ph-tile clickable ${span}`} style={{ background: tileBg(photo) }} onClick={onOpen}>
      {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.caption} /> : photo.emoji ?? '🖼️'}
      <button
        type="button"
        className="ph-del"
        aria-label={`Delete ${photo.caption}`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ×
      </button>
      <div className="heart">{photo.isFavorite ? '❤️' : ''}</div>
      <div className="ph-cap">{photo.caption}</div>
    </div>
  )
}

// Full-screen screensaver takeover — mirrors photos-screensaver.png.
function Screensaver({ photo, thumbs, onWake }: { photo: Photo; thumbs: Photo[]; onWake: () => void }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const bg = tileBg(photo)
  return (
    <div className="ph-saver" style={{ background: bg }} onClick={onWake} role="button" aria-label="Wake screensaver">
      {photo.imageUrl && <img className="ph-saver-img" src={photo.imageUrl} alt="" />}
      <div className="ph-saver-scrim" />
      <div className="ph-saver-clock">
        <div className="nk-serif ph-saver-time">{time}</div>
        <div className="ph-saver-date">{date} · 60° &amp; clear</div>
      </div>
      <div className="ph-saver-weather">☀️</div>
      {!photo.imageUrl && <div className="ph-saver-hero">{photo.emoji ?? '🏖️'}</div>}
      <div className="ph-saver-meta">
        <div className="nk-serif">{photo.memory ?? photo.caption}</div>
        <div className="ph-saver-meta-sub">{thumbs.length} photos from {weekdayOf(photo)}</div>
      </div>
      <div className="ph-saver-thumbs">
        {thumbs.slice(0, 5).map((p, i) => (
          <div key={p.id} className={`ph-saver-thumb ${i === 0 ? 'on' : ''}`} style={{ background: tileBg(p) }}>
            {p.imageUrl ? <img src={p.imageUrl} alt="" /> : p.emoji ?? '🖼️'}
          </div>
        ))}
      </div>
      <div className="ph-saver-wake">Tap anywhere to wake</div>
    </div>
  )
}

export function Photos() {
  const { photos, loading, error, refetch } = usePhotos()
  const [adding, setAdding] = useState(false)
  const [detail, setDetail] = useState<Photo | null>(null)
  const [saver, setSaver] = useState<Photo | null>(null)

  // The newest memory drives the banner + the default screensaver.
  const newest = photos[0] ?? null
  const memory = newest?.memory ?? null
  const memoryPhotos = useMemo(
    () => (memory ? photos.filter((p) => p.memory === memory) : []),
    [photos, memory]
  )
  const saverThumbs = saver?.memory ? photos.filter((p) => p.memory === saver.memory) : photos

  useTopbarRight(
    () => (
      <div className="tb-right">
        <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setSaver(newest)} disabled={!newest}>
          🖼️ Play screensaver
        </button>
        <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} onClick={() => setAdding(true)}>
          <Icon name="plus" />
          <span>Add photos</span>
        </button>
      </div>
    ),
    [newest]
  )

  async function del(p: Photo) {
    await api.deletePhoto(p.id)
    refetch()
  }

  if (error) {
    return <div className="ph-empty">Sign this kiosk in to see photos.</div>
  }

  return (
    <div className="photos-home">
      {newest && (
        <div className="ph-banner">
          <div className="ph-banner-tile" style={{ background: tileBg(newest) }}>
            {newest.imageUrl ? <img src={newest.imageUrl} alt="" /> : newest.emoji ?? '🏖️'}
          </div>
          <div style={{ flex: 1 }}>
            <div className="ai-tag" style={{ marginBottom: 4 }}>
              <Icon name="spark" />New memory
            </div>
            <div className="ph-banner-title">
              {memory
                ? `“${memory}” — ${memoryPhotos.length} photos from ${weekdayOf(newest)}`
                : `${photos.length} photos`}
            </div>
            <div className="tiny muted">Nook grouped them and set a few as the kitchen screensaver. Tap any photo to view.</div>
          </div>
          <button type="button" className="btn btn-ghost btn-play" onClick={() => setSaver(newest)}>▶ Play</button>
        </div>
      )}

      <div className="photos-wall-scroll">
        {photos.length > 0 ? (
          <div className="ph-wall">
            {photos.map((p, i) => (
              <PhotoTile key={p.id} photo={p} span={spanFor(i)} onOpen={() => setDetail(p)} onDelete={() => del(p)} />
            ))}
          </div>
        ) : (
          !loading && <div className="ph-empty">No photos yet — add some with “Add photos”.</div>
        )}
      </div>

      {adding && <PhotoAdd onClose={() => setAdding(false)} onAdded={refetch} />}
      {detail && (
        <PhotoDetail
          photo={detail}
          memoryCount={detail.memory ? photos.filter((p) => p.memory === detail.memory).length : 1}
          onClose={() => setDetail(null)}
          onSetScreensaver={(p) => {
            setDetail(null)
            setSaver(p)
          }}
          onDeleted={refetch}
        />
      )}
      {saver && <Screensaver photo={saver} thumbs={saverThumbs} onWake={() => setSaver(null)} />}
    </div>
  )
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
