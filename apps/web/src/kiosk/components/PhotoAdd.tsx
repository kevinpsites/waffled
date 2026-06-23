import { useRef, useState } from 'react'
import { api, uploadImage } from '../../lib/api'

// Add-photos overlay — a back-pill topbar and a single real source: 📷 Upload
// photo. Nook has no shared-album / phone-library integration yet, so a muted
// "☁️ Shared album — soon" pill stands in for the planned source. Once a file is
// chosen it's re-encoded + sent to /api/media; we stage the returned storageKey
// (resolved to imageUrl server-side) with a preview, then a small form collects a
// caption, an album (existing or new, via a datalist), and a favorite toggle.

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

  function reset() {
    setUploadKey(null)
    setUploadPreview(null)
    setCaption('')
    setAlbum('')
    setIsFavorite(false)
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

  return (
    <div className="ph-saver" style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg, #efece6)', color: 'var(--ink)', display: 'block', cursor: 'default' }}>
      <div className="nk-kiosk nk" style={{ position: 'absolute', inset: 0, background: '#efece6' }}>
        <div className="kiosk-main" style={{ gridColumn: '1 / -1' }}>
          <div className="topbar">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Photos</button>
            <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginLeft: 14 }}>Add photos</div>
            <div className="tb-right">
              <button type="button" className="btn btn-primary" disabled={!uploadKey || saving} onClick={add}>
                {saving ? 'Adding…' : 'Add photo'}
              </button>
            </div>
          </div>

          <div className="ap-toolbar">
            <button type="button" className="pill ap-src" onClick={() => fileRef.current?.click()}>
              📷 Upload photo
            </button>
            <div className="pill ap-src ap-soon" aria-disabled="true">
              ☁️ Shared album <span className="ap-soon-tag">soon</span>
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
          </div>

          <div className="ap-body">
            {uploading && <div className="tiny muted" style={{ fontWeight: 700, padding: '8px 2px' }}>Uploading photo…</div>}
            {uploadErr && <div className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700, padding: '8px 2px' }}>{uploadErr}</div>}

            {uploadPreview && !uploading && (
              <div className="ap-form">
                <img className="ap-form-preview" src={uploadPreview} alt="Upload preview" />
                <div className="ap-form-fields">
                  <label className="ap-field-label">
                    Caption
                    <input className="field" placeholder="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} autoFocus />
                  </label>
                  <label className="ap-field-label">
                    Album
                    <input
                      className="field"
                      list="ap-album-list"
                      placeholder="Pick or name an album"
                      value={album}
                      onChange={(e) => setAlbum(e.target.value)}
                    />
                    <datalist id="ap-album-list">
                      {albums.map((a) => (
                        <option key={a} value={a} />
                      ))}
                    </datalist>
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
                    <button type="button" className="pill" onClick={reset}>Remove</button>
                  </div>
                </div>
              </div>
            )}

            {!uploadPreview && !uploading && (
              <div className="ap-hint tiny muted">Tap “Upload photo” to add a photo from this device.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
