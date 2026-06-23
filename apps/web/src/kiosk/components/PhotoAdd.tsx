import { useRef, useState } from 'react'
import { api, uploadImage } from '../../lib/api'
import { Icon } from '../icons'

// Add-photos overlay — matches photos-add.png: a back-pill topbar, source
// toolbar, the "Nook found N new photos" banner, and a RECENT grid of selectable
// candidate tiles. Since Nook has no photo library / blob storage yet, the
// candidates are emoji + color tiles (exactly what the mock renders); selecting
// them and tapping "Add N photos" creates real photos in the "Lake Day" memory.
// An "Import a link" path covers real image URLs.

const MEMORY = 'Lake Day'

// the candidate tiles from the mock (screens-extra.js → addPhotos.recent)
const CANDIDATES: { emoji: string; colorHex: string; caption: string }[] = [
  { emoji: '🏖️', colorHex: '#7fc1e8', caption: 'Beach day' },
  { emoji: '🎂', colorHex: '#f6c24f', caption: 'Birthday' },
  { emoji: '🐢', colorHex: '#a8d98a', caption: "Wally's turtle" },
  { emoji: '🩰', colorHex: '#e58ab0', caption: 'Recital' },
  { emoji: '🍝', colorHex: '#f0a87f', caption: 'Taco night' },
  { emoji: '🦄', colorHex: '#b59ae8', caption: 'Lottie art' },
  { emoji: '⚽', colorHex: '#8fd3c4', caption: 'Soccer win' },
  { emoji: '🥞', colorHex: '#f5c98a', caption: 'Sat pancakes' },
  { emoji: '🏞️', colorHex: '#c9b8a8', caption: 'Lake view' },
  { emoji: '❄️', colorHex: '#9cc5e0', caption: 'First snow' },
]

const SOURCES: [string, string][] = [
  ['📷', 'Upload photo'],
  ['🖼️', 'Phone library'],
  ['☁️', 'Shared album'],
  ['🔗', 'Import a link'],
]

export function PhotoAdd({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkCaption, setLinkCaption] = useState('')
  const [saving, setSaving] = useState(false)

  // Uploaded photo: a chosen file is re-encoded + sent to /api/media, and we stage the
  // returned storageKey (resolved to imageUrl server-side) with an inline preview.
  const [uploadKey, setUploadKey] = useState<string | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadCaption, setUploadCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const count = selected.size + (linkOpen && linkUrl.trim() ? 1 : 0) + (uploadKey ? 1 : 0)

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

  function toggle(i: number) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  async function add() {
    if (!count || saving) return
    setSaving(true)
    try {
      const jobs = [...selected].map((i) => {
        const c = CANDIDATES[i]
        return api.createPhoto({ caption: c.caption, emoji: c.emoji, colorHex: c.colorHex, memory: MEMORY })
      })
      if (linkOpen && linkUrl.trim()) {
        jobs.push(api.createPhoto({ caption: linkCaption.trim() || 'New photo', imageUrl: linkUrl.trim(), memory: MEMORY }))
      }
      if (uploadKey) {
        jobs.push(api.createPhoto({ caption: uploadCaption.trim() || 'New photo', storageKey: uploadKey, memory: MEMORY }))
      }
      await Promise.all(jobs)
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
              <button type="button" className="btn btn-primary" disabled={!count || saving} onClick={add}>
                {saving ? 'Adding…' : <>Add <span className="ap-count">{count}</span> photos</>}
              </button>
            </div>
          </div>

          <div className="ap-toolbar">
            {SOURCES.map(([e, t]) => (
              <div
                key={t}
                className="pill"
                onClick={() => {
                  if (t === 'Import a link') setLinkOpen((v) => !v)
                  else if (t === 'Upload photo') fileRef.current?.click()
                }}
                style={t === 'Import a link' ? { boxShadow: linkOpen ? '0 0 0 2px var(--primary)' : undefined } : undefined}
              >
                {e} {t}
              </div>
            ))}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = '' }}
            />
          </div>

          {linkOpen && (
            <div className="ap-link-field">
              <input className="field" placeholder="https://… image link" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} autoFocus />
              <input className="field" placeholder="Caption" value={linkCaption} onChange={(e) => setLinkCaption(e.target.value)} style={{ maxWidth: 200 }} />
            </div>
          )}

          {(uploading || uploadErr || uploadPreview) && (
            <div className="ap-link-field" style={{ alignItems: 'center' }}>
              {uploading && <span className="tiny muted" style={{ fontWeight: 700 }}>Uploading photo…</span>}
              {uploadErr && <span className="tiny" style={{ color: 'var(--danger,#c0392b)', fontWeight: 700 }}>{uploadErr}</span>}
              {uploadPreview && !uploading && (
                <>
                  <img src={uploadPreview} alt="Upload preview" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 10 }} />
                  <input className="field" placeholder="Caption" value={uploadCaption} onChange={(e) => setUploadCaption(e.target.value)} style={{ maxWidth: 200 }} />
                  <button type="button" className="pill" onClick={() => { setUploadKey(null); setUploadPreview(null); setUploadCaption('') }}>Remove</button>
                </>
              )}
            </div>
          )}

          <div className="ap-found">
            <div className="ai-spark"><Icon name="spark" /></div>
            <div style={{ flex: 1 }}>
              <div className="ap-found-t">Nook found {CANDIDATES.length} new photos from Saturday</div>
              <div className="tiny muted">Tap the ones to add — Nook groups them into a memory and updates the screensaver.</div>
            </div>
          </div>

          <div className="ap-body">
            <div className="ap-recent-label">RECENT</div>
            <div className="ap-grid">
              {CANDIDATES.map((c, i) => {
                const on = selected.has(i)
                return (
                  <div
                    key={i}
                    className={`ap-tile ${on ? 'on' : ''}`}
                    style={{ background: `linear-gradient(135deg, ${c.colorHex}, ${shade(c.colorHex)})` }}
                    onClick={() => toggle(i)}
                  >
                    {c.emoji}
                    <div className="ap-chk">{on ? '✓' : ''}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// darken a hex color a touch for the gradient's second stop (mirrors the mock's
// hand-picked two-stop gradients).
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
