import { useState } from 'react'
import { api, type Photo } from '../../lib/api'
import { AlbumPicker } from './AlbumPicker'
import { ConfirmDialog } from './ConfirmDialog'

// Photo detail overlay — a back-pill topbar with "Set as screensaver / ✏️ Edit /
// 🗑", the big photo stage on the left, and the Details / "Part of memory" AI
// cards on the right. Edit mode turns the Details card into editable caption /
// album (datalist of existing albums) / favorite / date fields; Save PATCHes the
// photo and refetches the wall.

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtWeekday(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long' })
}
// ISO timestamp → YYYY-MM-DD for a <input type=date> value (and back).
function isoToDateInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function PhotoDetail({
  photo,
  memoryCount,
  albums = [],
  onClose,
  onOpenAlbum,
  onUpdated,
  onDeleted,
}: {
  photo: Photo
  memoryCount: number
  albums?: string[]
  onClose: () => void
  onOpenAlbum?: (album: string) => void
  onUpdated?: () => void
  onDeleted: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [caption, setCaption] = useState(photo.caption)
  const [album, setAlbum] = useState(photo.memory ?? '')
  const [isFavorite, setIsFavorite] = useState(photo.isFavorite)
  const [takenDate, setTakenDate] = useState(isoToDateInput(photo.takenAt ?? photo.createdAt))

  const bg = `linear-gradient(135deg, ${photo.colorHex ?? '#7fc1e8'}, ${shade(photo.colorHex ?? '#7fc1e8')})`

  function startEdit() {
    setCaption(photo.caption)
    setAlbum(photo.memory ?? '')
    setIsFavorite(photo.isFavorite)
    setTakenDate(isoToDateInput(photo.takenAt ?? photo.createdAt))
    setEditing(true)
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      // takenDate "" means cleared; a date value becomes a noon-local ISO so it lands
      // on the chosen day regardless of timezone.
      const takenAt = takenDate ? new Date(`${takenDate}T12:00:00`).toISOString() : null
      await api.updatePhoto(photo.id, {
        caption: caption.trim(),
        memory: album.trim() || null,
        isFavorite,
        takenAt,
      })
      onUpdated?.()
      setEditing(false)
    } catch {
      /* keep edit mode open on failure */
    } finally {
      setSaving(false)
    }
  }

  async function del() {
    await api.deletePhoto(photo.id)
    onDeleted()
    onClose()
  }

  return (
    <div className="ph-saver" style={{ zIndex: 900, background: '#efece6', color: 'var(--ink)', display: 'block', cursor: 'default' }}>
      <div className="wf-kiosk wf" style={{ position: 'absolute', inset: 0, background: '#efece6' }}>
        <div className="kiosk-main" style={{ gridColumn: '1 / -1' }}>
          <div className="topbar">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Photos</button>
            <div className="tb-right">
              {!editing && (
                <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={startEdit}>✏️ Edit</button>
              )}
              <button type="button" className="icon-btn" style={{ cursor: 'pointer' }} aria-label="Delete photo" onClick={() => setConfirmDel(true)}>
                🗑
              </button>
            </div>
          </div>

          <div className="photo-detail">
            <div className="pd-stage" style={{ background: bg }}>
              {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.caption} /> : photo.emoji ?? '🏖️'}
              <div className="pd-stage-cap">
                {photo.caption && <div className="wf-serif">{photo.caption}</div>}
                <div className="pd-stage-sub">
                  {fmtWeekday(photo.takenAt ?? photo.createdAt)}
                  {photo.memory ? ` · ${photo.memory}` : ''}
                </div>
              </div>
            </div>

            <div className="pd-side">
              <div className="card" style={{ padding: '18px 20px' }}>
                <div className="card-h" style={{ fontSize: 17, marginBottom: 10 }}>
                  Details
                </div>

                {editing ? (
                  <div className="pd-edit">
                    <label className="ap-field-label">
                      Caption
                      <input className="field" placeholder="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} />
                    </label>
                    <label className="ap-field-label">
                      Album
                      <AlbumPicker value={album} onChange={setAlbum} albums={albums} />
                    </label>
                    <label className="ap-field-label">
                      Date
                      <input className="field" type="date" value={takenDate} onChange={(e) => setTakenDate(e.target.value)} />
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
                    </div>
                    <div className="pd-edit-actions">
                      <button type="button" className="pill" onClick={() => setEditing(false)}>Cancel</button>
                      <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="set-row" style={{ padding: '11px 0' }}>
                      <div className="set-tx"><div className="st1">Album</div></div>
                      {photo.memory && onOpenAlbum ? (
                        <button type="button" className="pd-album-link" style={{ marginLeft: 'auto' }} onClick={() => onOpenAlbum(photo.memory!)}>
                          {photo.memory} <span aria-hidden>›</span>
                        </button>
                      ) : (
                        <div className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{photo.memory ?? '—'}</div>
                      )}
                    </div>
                    <div className="set-row" style={{ padding: '11px 0' }}>
                      <div className="set-tx"><div className="st1">Added by</div></div>
                      <span className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{photo.uploadedBy?.name ?? '—'}</span>
                    </div>
                    <div className="set-row" style={{ padding: '11px 0' }}>
                      <div className="set-tx"><div className="st1">Date</div></div>
                      <div className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{fmtDate(photo.takenAt ?? photo.createdAt)}</div>
                    </div>
                    <div className="set-row" style={{ padding: '11px 0', borderBottom: 0 }}>
                      <div className="set-tx"><div className="st1">Favorite</div></div>
                      <div className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{photo.isFavorite ? '❤️ Yes' : 'No'}</div>
                    </div>
                  </>
                )}
              </div>

              {photo.memory && onOpenAlbum && (
                <button type="button" className="pd-album-cta" onClick={() => onOpenAlbum(photo.memory!)}>
                  <span>View all {memoryCount} in “{photo.memory}”</span>
                  <span aria-hidden>›</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmDel && (
        <ConfirmDialog
          title="Delete photo?"
          message="This can’t be undone."
          confirmLabel="Delete"
          danger
          onConfirm={del}
          onClose={() => setConfirmDel(false)}
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
