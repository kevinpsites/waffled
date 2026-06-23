import { useMemo, useState } from 'react'
import { api, usePhotos, useWeather, useHousehold, type Photo } from '../lib/api'
import { Icon } from './icons'
import { useTopbarRight } from './topbar-slot'
import { PhotoAdd } from './components/PhotoAdd'
import { PhotoDetail } from './components/PhotoDetail'
import { Screensaver } from './components/Screensaver'
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

function PhotoTile({ photo, onOpen, onDelete }: { photo: Photo; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className={`ph-tile clickable ${photo.imageUrl ? '' : 'no-img'}`} style={{ background: tileBg(photo) }} onClick={onOpen}>
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

export function Photos() {
  const { photos, loading, error, refetch } = usePhotos()
  const wx = useWeather()
  const { household } = useHousehold()
  const [adding, setAdding] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [saver, setSaver] = useState<Photo | null>(null)
  const [albumFilter, setAlbumFilter] = useState<string | null>(null)

  // Derive the open detail photo live from the list (by id) so an edit + refetch
  // shows the saved values; a stored snapshot would go stale and look unsaved.
  const detail = detailId ? (photos.find((p) => p.id === detailId) ?? null) : null

  // The newest memory drives the banner + the default screensaver.
  const newest = photos[0] ?? null
  const memory = newest?.memory ?? null
  const memoryPhotos = useMemo(
    () => (memory ? photos.filter((p) => p.memory === memory) : []),
    [photos, memory]
  )
  const saverThumbs = saver?.memory ? photos.filter((p) => p.memory === saver.memory) : photos

  // Distinct album names (a photo's `memory`), for the filter chips + the add/edit datalists.
  const albums = useMemo(
    () => [...new Set(photos.map((p) => p.memory).filter((m): m is string => !!m))],
    [photos]
  )
  // The wall, filtered to the chosen album ("All" → everything).
  const visiblePhotos = useMemo(
    () => (albumFilter ? photos.filter((p) => p.memory === albumFilter) : photos),
    [photos, albumFilter]
  )

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

      {albums.length > 0 && (
        <div className="ph-filter">
          <button
            type="button"
            className={`pill ph-chip ${albumFilter === null ? 'on' : ''}`}
            onClick={() => setAlbumFilter(null)}
          >
            All
          </button>
          {albums.map((a) => (
            <button
              key={a}
              type="button"
              className={`pill ph-chip ${albumFilter === a ? 'on' : ''}`}
              onClick={() => setAlbumFilter(a)}
            >
              {a}
            </button>
          ))}
        </div>
      )}

      <div className="photos-wall-scroll">
        {visiblePhotos.length > 0 ? (
          <div className="ph-wall">
            {visiblePhotos.map((p) => (
              <PhotoTile key={p.id} photo={p} onOpen={() => setDetailId(p.id)} onDelete={() => del(p)} />
            ))}
          </div>
        ) : (
          !loading && (
            <div className="ph-empty">
              {photos.length === 0 ? 'No photos yet — add some with “Add photos”.' : 'No photos in this album.'}
            </div>
          )
        )}
      </div>

      {adding && <PhotoAdd onClose={() => setAdding(false)} onAdded={refetch} albums={albums} />}
      {detail && (
        <PhotoDetail
          photo={detail}
          memoryCount={detail.memory ? photos.filter((p) => p.memory === detail.memory).length : 1}
          albums={albums}
          onClose={() => setDetailId(null)}
          onSetScreensaver={(p) => {
            setDetailId(null)
            setSaver(p)
          }}
          onUpdated={refetch}
          onDeleted={refetch}
        />
      )}
      {saver && (
        <Screensaver
          content="photos"
          photos={saverThumbs}
          weather={wx}
          nextEvent={null}
          timezone={household?.timezone}
          onWake={() => setSaver(null)}
        />
      )}
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
