import { useRef, useState } from 'react'
import { api, uploadImage } from '../../lib/api'
import { AlbumPicker } from './AlbumPicker'

// Add-photos overlay. The hero is a big drag-and-drop / click-to-browse zone — the
// single way to pick a photo (no separate "Upload" + "Add" buttons). Once a file is
// chosen it's re-encoded + sent to /api/media; we stage the returned storageKey
// (resolved to imageUrl server-side) as a centered preview card with caption, album
// (existing or new) and a favorite toggle, and the topbar's "Add photo" confirms.
// Nook has no shared-album / phone-library integration yet, so a muted "coming soon"
// note stands in for the planned second source.

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

  // Uploaded photo: a chosen file is re-encoded + sent to /api/media, and we stage the
  // returned storageKey (resolved to imageUrl server-side) with an inline preview.
  const [uploadKey, setUploadKey] = useState<string | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [album, setAlbum] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onPickFile(file: File | undefined) {
    if (!file) return
    setUploadErr(null)
    setUploading(true)
    try {
      const { key, url } = await uploadImage(file)
      setUploadKey(key)
      setUploadPreview(url)
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed — please try again.')
    } finally {
      setUploading(false)
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    onPickFile(e.dataTransfer.files?.[0])
  }

  function reset() {
    setUploadKey(null)
    setUploadPreview(null)
    setCaption('')
    setAlbum('')
    setIsFavorite(false)
    setUploadErr(null)
  }

  async function add() {
    if (!uploadKey || saving) return
    setSaving(true)
    try {
      await api.createPhoto({
        storageKey: uploadKey,
        caption: caption.trim() || 'New photo',
        memory: album.trim() || null,
        isFavorite,
      })
      onAdded()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  const staged = !!uploadPreview && !uploading

  return (
    <div className="ph-saver" style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg, #efece6)', color: 'var(--ink)', display: 'block', cursor: 'default' }}>
      <div className="nk-kiosk nk" style={{ position: 'absolute', inset: 0, background: '#efece6' }}>
        <div className="kiosk-main" style={{ gridColumn: '1 / -1' }}>
          <div className="topbar">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Photos</button>
            <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>Add a photo</div>
            <div className="tb-right">
              {staged && (
                <button type="button" className="btn btn-primary" disabled={saving} onClick={add}>
                  {saving ? 'Adding…' : 'Add photo'}
                </button>
              )}
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            // Only formats the browser canvas can decode + re-encode. This greys out
            // HEIC (iPhone's default) in the file picker; uploadImage() also guards at
            // runtime for drag-drop / pickers that ignore `accept`.
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            style={{ display: 'none' }}
            onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = '' }}
          />

          <div className="ap-stage">
            {!staged ? (
              <div className="ap-pick">
                <button
                  type="button"
                  className={`ap-drop ${dragOver ? 'over' : ''} ${uploading ? 'busy' : ''}`}
                  onClick={() => !uploading && fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  disabled={uploading}
                >
                  {uploading ? (
                    <>
                      <div className="ap-drop-icon">⏳</div>
                      <div className="ap-drop-title">Uploading photo…</div>
                      <div className="ap-drop-sub tiny muted">Resizing and saving your photo</div>
                    </>
                  ) : (
                    <>
                      <div className="ap-drop-icon">📷</div>
                      <div className="ap-drop-title">Drag &amp; drop a photo here</div>
                      <div className="ap-drop-sub">or <span className="ap-drop-link">click to browse</span></div>
                      <div className="ap-drop-meta tiny muted">JPG, PNG or WebP · up to 10&nbsp;MB</div>
                    </>
                  )}
                </button>

                {uploadErr && <div className="ap-err tiny">{uploadErr}</div>}
              </div>
            ) : (
              <div className="ap-card">
                <div className="ap-card-photo">
                  <img src={uploadPreview!} alt="Upload preview" />
                  {isFavorite && <div className="ap-card-heart">❤️</div>}
                </div>
                <div className="ap-card-fields">
                  <label className="ap-field-label">
                    Caption
                    <input className="field" placeholder="Add a caption…" value={caption} onChange={(e) => setCaption(e.target.value)} autoFocus />
                  </label>
                  <label className="ap-field-label">
                    Album
                    <AlbumPicker value={album} onChange={setAlbum} albums={albums} />
                  </label>
                  <div className="ap-form-row">
                    <button
                      type="button"
                      className={`pill ap-fav ${isFavorite ? 'on' : ''}`}
                      aria-pressed={isFavorite}
                      onClick={() => setIsFavorite((v) => !v)}
                    >
                      {isFavorite ? '❤️' : '🤍'} Favorite
                    </button>
                    <button type="button" className="pill" onClick={() => fileRef.current?.click()}>↻ Replace</button>
                    <button type="button" className="pill" onClick={reset}>Remove</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
