import { useMemo, useRef, useState } from 'react'
import { api, uploadImage } from '../../lib/api'
import { AlbumPicker } from './AlbumPicker'

// Add-photos overlay. The hero is a big drag-and-drop / click-to-browse zone that
// accepts up to MAX photos at once. Each chosen file is re-encoded + sent to
// /api/media; we stage the returned storageKey (resolved to imageUrl server-side) as
// a row in a list, each with its own caption, favorite toggle and album. A "Album for
// all" picker sets the batch default and propagates to every row that still matches it,
// so the common case (one event → one album) is one tap, while any single photo can
// still be pointed at a different album. "Add photo(s)" creates them all.

const MAX = 10

interface StagedPhoto {
  key: string
  previewUrl: string
  caption: string
  isFavorite: boolean
  album: string
}

export function PhotoAdd({
  onClose,
  onAdded,
  albums = [],
}: {
  onClose: () => void
  onAdded: () => void
  albums?: string[]
}) {
  const [saving, setSaving] = useState(false)
  const [items, setItems] = useState<StagedPhoto[]>([])
  const [sharedAlbum, setSharedAlbum] = useState('')
  const [uploading, setUploading] = useState(0)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Per-row album pickers offer every known album PLUS any freshly-typed batch / row
  // name, so a brand-new album shows as a selectable option on every row (not a stray
  // "new album" text box repeated down the list).
  const allAlbums = useMemo(
    () => [...new Set([...albums, sharedAlbum, ...items.map((i) => i.album)].filter((a): a is string => !!a))],
    [albums, sharedAlbum, items]
  )

  async function onPickFiles(fileList: FileList | File[] | null | undefined) {
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    const room = MAX - items.length
    const take = files.slice(0, Math.max(0, room))
    const dropped = files.length - take.length
    setUploadErr(dropped > 0 ? `You can add up to ${MAX} photos at once — ${dropped} not added.` : null)
    setUploading((n) => n + take.length)
    await Promise.all(
      take.map(async (file) => {
        try {
          const { key, url } = await uploadImage(file)
          setItems((prev) => [...prev, { key, previewUrl: url, caption: '', isFavorite: false, album: sharedAlbum }])
        } catch (e) {
          setUploadErr(e instanceof Error ? e.message : 'A photo failed to upload — please try again.')
        } finally {
          setUploading((n) => n - 1)
        }
      })
    )
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    onPickFiles(e.dataTransfer.files)
  }

  // Changing the batch album re-points every row that still matches the OLD batch
  // value, leaving rows the user individually overrode untouched.
  function changeSharedAlbum(next: string) {
    setItems((prev) => prev.map((it) => (it.album === sharedAlbum ? { ...it, album: next } : it)))
    setSharedAlbum(next)
  }

  function patchItem(i: number, patch: Partial<StagedPhoto>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  }

  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function add() {
    if (!items.length || saving || uploading > 0) return
    setSaving(true)
    try {
      for (const it of items) {
        await api.createPhoto({
          storageKey: it.key,
          caption: it.caption.trim(),
          memory: it.album.trim() || null,
          isFavorite: it.isFavorite,
        })
      }
      onAdded()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  const staged = items.length > 0
  const addLabel = saving ? 'Adding…' : items.length > 1 ? `Add ${items.length} photos` : 'Add photo'

  return (
    <div className="ph-saver" style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg)', color: 'var(--ink)', display: 'block', cursor: 'default' }}>
      <div className="wf-kiosk wf" style={{ position: 'absolute', inset: 0, background: '#efece6' }}>
        <div className="kiosk-main" style={{ gridColumn: '1 / -1' }}>
          <div className="topbar">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Photos</button>
            <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>Add photos</div>
            <div className="tb-right">
              {staged && (
                <button type="button" className="btn btn-primary" disabled={saving || uploading > 0} onClick={add}>
                  {addLabel}
                </button>
              )}
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            multiple
            // Only formats the browser canvas can decode + re-encode. This greys out
            // HEIC (iPhone's default) in the file picker; uploadImage() also guards at
            // runtime for drag-drop / pickers that ignore `accept`.
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            style={{ display: 'none' }}
            onChange={(e) => { onPickFiles(e.target.files); e.target.value = '' }}
          />

          <div className={`ap-stage ${staged ? 'staged' : ''}`}>
            {!staged ? (
              <div className="ap-pick">
                <button
                  type="button"
                  className={`ap-drop ${dragOver ? 'over' : ''} ${uploading > 0 ? 'busy' : ''}`}
                  onClick={() => uploading === 0 && fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  disabled={uploading > 0}
                >
                  {uploading > 0 ? (
                    <>
                      <div className="ap-drop-icon">⏳</div>
                      <div className="ap-drop-title">Uploading…</div>
                      <div className="ap-drop-sub tiny muted">Resizing and saving your photos</div>
                    </>
                  ) : (
                    <>
                      <div className="ap-drop-icon">📷</div>
                      <div className="ap-drop-title">Drag &amp; drop photos here</div>
                      <div className="ap-drop-sub">or <span className="ap-drop-link">click to browse</span></div>
                      <div className="ap-drop-meta tiny muted">Up to {MAX} at once · JPG, PNG or WebP · 10&nbsp;MB each</div>
                    </>
                  )}
                </button>
                {uploadErr && <div className="ap-err tiny">{uploadErr}</div>}
              </div>
            ) : (
              <div className="ap-batch">
                <div className="ap-batch-bar">
                  <label className="ap-field-label ap-batch-album">
                    Album for all
                    <AlbumPicker id="ap-shared-album" value={sharedAlbum} onChange={changeSharedAlbum} albums={albums} />
                  </label>
                  <div className="ap-batch-actions">
                    <span className="tiny muted">{items.length} / {MAX}</span>
                    <button
                      type="button"
                      className="pill"
                      onClick={() => fileRef.current?.click()}
                      disabled={items.length >= MAX || uploading > 0}
                    >
                      ＋ Add more
                    </button>
                  </div>
                </div>

                {uploadErr && <div className="ap-err tiny">{uploadErr}</div>}
                {uploading > 0 && <div className="tiny muted ap-uploading">Uploading {uploading} more…</div>}

                <div className="ap-list">
                  {items.map((it, i) => (
                    <div className="ap-row" key={it.key}>
                      <div className="ap-row-thumb">
                        <img src={it.previewUrl} alt="" />
                      </div>
                      <div className="ap-row-fields">
                        <input
                          className="field"
                          placeholder="Add a caption…"
                          value={it.caption}
                          onChange={(e) => patchItem(i, { caption: e.target.value })}
                        />
                        <div className="ap-row-meta">
                          <button
                            type="button"
                            className={`pill ap-fav ${it.isFavorite ? 'on' : ''}`}
                            aria-pressed={it.isFavorite}
                            aria-label="Favorite"
                            onClick={() => patchItem(i, { isFavorite: !it.isFavorite })}
                          >
                            {it.isFavorite ? '❤️' : '🤍'}
                          </button>
                          <div className="ap-row-album">
                            <AlbumPicker value={it.album} onChange={(v) => patchItem(i, { album: v })} albums={allAlbums} />
                          </div>
                          <button
                            type="button"
                            className="ap-row-del"
                            aria-label="Remove photo"
                            onClick={() => removeItem(i)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
