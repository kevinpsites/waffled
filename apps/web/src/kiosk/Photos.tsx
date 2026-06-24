import { useEffect, useMemo, useState } from 'react'
import { api, kioskApi, usePhotos, useWeather, useHousehold, type DisplayConfig, type Photo } from '../lib/api'
import { Icon } from './icons'
import { useTopbarRight } from './topbar-slot'
import { PhotoAdd } from './components/PhotoAdd'
import { PhotoDetail } from './components/PhotoDetail'
import { Screensaver } from './components/Screensaver'
import { ConfirmDialog } from './components/ConfirmDialog'
import { MovePhotosModal } from './components/MovePhotosModal'
import '../styles/photos.css'

// Photos home — the family wall (matches photos.png): a "NEW MEMORY" banner over
// a masonry wall of tiles, each an <img> or an emoji-on-gradient tile (Nook has
// no blob storage yet, so emoji tiles are the intended fallback — the mock itself
// renders colored emoji tiles). Tapping a tile opens the detail; the topbar adds
// "Play screensaver" + "Add photos"; the screensaver is a full-screen takeover.

function tileBg(photo: Photo): string {
  const c = photo.colorHex ?? '#7fc1e8'
  return `linear-gradient(135deg, ${c}, ${shade(c)})`
}

function PhotoTile({
  photo,
  selectMode,
  selected,
  onOpen,
  onToggle,
  onRequestDelete,
}: {
  photo: Photo
  selectMode: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
  onRequestDelete: () => void
}) {
  return (
    <div
      className={`ph-tile clickable ${photo.imageUrl ? '' : 'no-img'} ${selectMode ? 'selecting' : ''} ${selected ? 'selected' : ''}`}
      style={{ background: tileBg(photo) }}
      onClick={selectMode ? onToggle : onOpen}
    >
      {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.caption} /> : photo.emoji ?? '🖼️'}
      {selectMode ? (
        <div className="ph-check" aria-hidden>{selected ? '✓' : ''}</div>
      ) : (
        <button
          type="button"
          className="ph-del"
          aria-label={`Delete ${photo.caption}`}
          onClick={(e) => {
            e.stopPropagation()
            onRequestDelete()
          }}
        >
          ×
        </button>
      )}
      <div className="heart">{photo.isFavorite ? '❤️' : ''}</div>
      {photo.caption && <div className="ph-cap">{photo.caption}</div>}
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
  const [displayCfg, setDisplayCfg] = useState<DisplayConfig | null>(null)
  // Multi-select: a Set of photo ids + the bulk-action modals (delete / move).
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)

  // Pull the household display config once so manual playback uses the same
  // transition speed as the idle screensaver (tolerate failure → default 10s).
  useEffect(() => {
    let alive = true
    kioskApi.displayConfig().then((c) => alive && setDisplayCfg(c)).catch(() => {})
    return () => { alive = false }
  }, [])

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

  function exitSelect() {
    setSelectMode(false)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useTopbarRight(
    () =>
      selectMode ? (
        <div className="tb-right">
          <span className="tiny muted" style={{ fontWeight: 700, marginRight: 4 }}>{selected.size} selected</span>
          <button type="button" className="pill" disabled={selected.size === 0} onClick={() => setMoveOpen(true)}>
            Move to album
          </button>
          <button
            type="button"
            className="pill"
            style={{ color: 'var(--danger, #c0392b)', cursor: 'pointer' }}
            disabled={selected.size === 0}
            onClick={() => setConfirmIds([...selected])}
          >
            Delete
          </button>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={exitSelect}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="tb-right">
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setSelectMode(true)} disabled={photos.length === 0}>
            Select
          </button>
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setSaver(newest)} disabled={!newest}>
            🖼️ Play screensaver
          </button>
          <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} onClick={() => setAdding(true)}>
            <Icon name="plus" />
            <span>Add photos</span>
          </button>
        </div>
      ),
    [newest, selectMode, selected, photos.length]
  )

  async function doDelete(ids: string[]) {
    await Promise.all(ids.map((id) => api.deletePhoto(id)))
    setConfirmIds(null)
    exitSelect()
    refetch()
  }

  async function doMove(album: string) {
    await Promise.all([...selected].map((id) => api.updatePhoto(id, { memory: album || null })))
    setMoveOpen(false)
    exitSelect()
    refetch()
  }

  // "Set as screensaver" from a photo: persist the household screensaver source to
  // this photo's album (or all photos if it has none), then start the slideshow.
  async function setScreensaverToAlbum(p: Photo) {
    const patch = p.memory
      ? ({ photoSource: 'album', photoAlbum: p.memory } as const)
      : ({ photoSource: 'all', photoAlbum: null } as const)
    try {
      const next = await kioskApi.setDisplayConfig(patch)
      setDisplayCfg(next)
    } catch {
      /* still play the preview even if persisting fails */
    }
    setDetailId(null)
    setSaver(p)
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
            <div className="ph-banner-tag" style={{ marginBottom: 4 }}>Recently added</div>
            <div className="ph-banner-title">
              {memory
                ? `“${memory}” — ${memoryPhotos.length} ${memoryPhotos.length === 1 ? 'photo' : 'photos'}`
                : `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`}
            </div>
            <div className="tiny muted">Tap any photo to view, or play them as a slideshow.</div>
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
              <PhotoTile
                key={p.id}
                photo={p}
                selectMode={selectMode}
                selected={selected.has(p.id)}
                onOpen={() => setDetailId(p.id)}
                onToggle={() => toggleSelect(p.id)}
                onRequestDelete={() => setConfirmIds([p.id])}
              />
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
          onSetScreensaver={setScreensaverToAlbum}
          onOpenAlbum={(album) => {
            setDetailId(null)
            setAlbumFilter(album)
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
          intervalSeconds={displayCfg?.photoInterval}
          bare
          onWake={() => setSaver(null)}
        />
      )}
      {confirmIds && (
        <ConfirmDialog
          title={confirmIds.length > 1 ? `Delete ${confirmIds.length} photos?` : 'Delete photo?'}
          message="This can’t be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => doDelete(confirmIds)}
          onClose={() => setConfirmIds(null)}
        />
      )}
      {moveOpen && (
        <MovePhotosModal
          count={selected.size}
          albums={albums}
          onMove={doMove}
          onClose={() => setMoveOpen(false)}
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
