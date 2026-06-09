import { useState } from 'react'
import { api, type Photo } from '../../lib/api'
import { Icon } from '../icons'

// Photo detail overlay — matches photos-detail.png: a back-pill topbar with
// "Set as screensaver / Share / 🗑", the big photo stage on the left, and the
// Reactions / Details / "Part of memory" AI cards on the right.

const REACTIONS = ['❤️', '😍', '🎉', '👏']

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtWeekday(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'long' })
}

export function PhotoDetail({
  photo,
  memoryCount,
  onClose,
  onSetScreensaver,
  onDeleted,
}: {
  photo: Photo
  memoryCount: number
  onClose: () => void
  onSetScreensaver: (p: Photo) => void
  onDeleted: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const [reacted, setReacted] = useState<string | null>(null)
  const bg = `linear-gradient(135deg, ${photo.colorHex ?? '#7fc1e8'}, ${shade(photo.colorHex ?? '#7fc1e8')})`
  const lovers = photo.uploadedBy?.name ? `${firstName(photo.uploadedBy.name)} loved this` : 'Loved by the family'

  async function del() {
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    await api.deletePhoto(photo.id)
    onDeleted()
    onClose()
  }

  return (
    <div className="ph-saver" style={{ zIndex: 900, background: '#efece6', color: 'var(--ink)', display: 'block', cursor: 'default' }}>
      <div className="nk-kiosk nk" style={{ position: 'absolute', inset: 0, background: '#efece6' }}>
        <div className="kiosk-main" style={{ gridColumn: '1 / -1' }}>
          <div className="topbar">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Photos</button>
            <div className="tb-right">
              <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => onSetScreensaver(photo)}>Set as screensaver</button>
              <button type="button" className="pill" style={{ cursor: 'pointer' }}>
                <Icon name="plus" />Share
              </button>
              <button type="button" className="icon-btn" style={{ cursor: 'pointer', color: confirmDel ? 'var(--primary)' : undefined }} aria-label="Delete photo" onClick={del}>
                🗑
              </button>
            </div>
          </div>

          <div className="photo-detail">
            <div className="pd-stage" style={{ background: bg }}>
              {photo.imageUrl ? <img src={photo.imageUrl} alt={photo.caption} /> : photo.emoji ?? '🏖️'}
              <div className="pd-stage-cap">
                <div className="nk-serif">{photo.caption}</div>
                <div className="pd-stage-sub">
                  {fmtWeekday(photo.takenAt ?? photo.createdAt)}
                  {photo.memory ? ` · ${memoryCount} photos in this memory` : ''}
                </div>
              </div>
            </div>

            <div className="pd-side">
              <div className="card" style={{ padding: '18px 20px' }}>
                <div className="card-h" style={{ fontSize: 17, marginBottom: 12 }}>Reactions</div>
                <div className="pd-react-row">
                  {REACTIONS.map((em) => (
                    <div key={em} className={`pill react ${reacted === em ? 'on' : ''}`} onClick={() => setReacted(em)}>
                      {em}
                    </div>
                  ))}
                </div>
                <div className="pd-loved">
                  <div className="avstack">
                    {photo.uploadedBy && (
                      <div className="av sm" style={{ background: `${photo.uploadedBy.colorHex ?? '#A6A29B'}22` }}>
                        {photo.uploadedBy.avatarEmoji ?? '🙂'}
                      </div>
                    )}
                  </div>
                  <span className="tiny muted" style={{ fontWeight: 600 }}>{lovers}</span>
                </div>
              </div>

              <div className="card" style={{ padding: '18px 20px' }}>
                <div className="card-h" style={{ fontSize: 17, marginBottom: 10 }}>Details</div>
                <div className="set-row" style={{ padding: '11px 0' }}>
                  <div className="set-tx"><div className="st1">Album</div></div>
                  <div className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{photo.memory ?? '—'}</div>
                </div>
                <div className="set-row" style={{ padding: '11px 0' }}>
                  <div className="set-tx"><div className="st1">Added by</div></div>
                  <span className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{photo.uploadedBy?.name ?? '—'}</span>
                </div>
                <div className="set-row" style={{ padding: '11px 0', borderBottom: 0 }}>
                  <div className="set-tx"><div className="st1">Date</div></div>
                  <div className="tiny muted" style={{ fontWeight: 600, marginLeft: 'auto' }}>{fmtDate(photo.takenAt ?? photo.createdAt)}</div>
                </div>
              </div>

              {photo.memory && (
                <div className="pd-ai">
                  <div className="ai-spark"><Icon name="spark" /></div>
                  <div style={{ flex: 1 }}>
                    <div className="pd-ai-t">Part of “{photo.memory}”</div>
                    <div className="tiny muted">Nook grouped {memoryCount} photos from this trip. Want a printed photo book of this memory?</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function firstName(name: string): string {
  return name.split(' ')[0]
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
