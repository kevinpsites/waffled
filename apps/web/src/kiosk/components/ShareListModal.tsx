import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { formatShareList, type ShareListItem } from './share-list'
import {
  QR_DISPLAY_PX,
  QR_ERROR_CORRECTION,
  QR_MARGIN_MODULES,
  qrBitmapPx,
  qrIsScannable,
} from './share-qr'

// "Share list" — the grocery handoff. Shows the board's unchecked items as a
// clean aisle-grouped text list with copy, navigator.share, and a QR code that
// encodes the text ITSELF (not a link), so a phone camera grabs the whole list
// with no app, no account, and no server round-trip.
//
// The QR only appears when it can actually be read: a long list pushes the code
// to a high version until its modules are sub-pixel on screen, at which point we
// say so rather than drawing something that merely looks like a QR. See
// share-qr.ts. Copy and the share sheet have no length limit, so the handoff
// never depends on the code.

const canShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

export function ShareListModal({ items, onClose }: { items: ShareListItem[]; onClose: () => void }) {
  const text = formatShareList(items)
  const count = items.filter((i) => !i.checked).length
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Measure before drawing: how many modules would this payload need, and does
  // that leave enough pixels each at the size we display it?
  const scannable = useMemo(() => {
    if (!text) return false
    try {
      return qrIsScannable(QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION }).modules.size)
    } catch {
      return false // payload beyond QR's capacity entirely
    }
  }, [text])

  useEffect(() => {
    if (!text || !scannable) {
      setQr(null)
      return
    }
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    QRCode.toDataURL(text, {
      width: qrBitmapPx(dpr),
      margin: QR_MARGIN_MODULES,
      errorCorrectionLevel: QR_ERROR_CORRECTION,
    })
      .then(setQr)
      .catch(() => setQr(null))
  }, [text, scannable])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (http / permissions) — the QR still works
    }
  }
  async function share() {
    try {
      await navigator.share({ title: 'Grocery list', text })
    } catch {
      // user dismissed the share sheet — nothing to do
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 560, maxHeight: '86vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="card-h wf-serif" style={{ fontSize: 22, marginBottom: 4 }}>Share list</div>

        {!text ? (
          <div className="muted" style={{ padding: '12px 0' }}>Nothing to share — everything’s checked off. 🎉</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0' }}>
              {qr && (
                <img
                  src={qr}
                  alt="Scan to grab the list"
                  width={QR_DISPLAY_PX}
                  height={QR_DISPLAY_PX}
                  style={{ borderRadius: 12, background: '#fff', imageRendering: 'pixelated' }}
                />
              )}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{count} item{count === 1 ? '' : 's'} to get</div>
                <div className="tiny muted" style={{ marginBottom: 10 }}>
                  {scannable
                    ? 'Scan with a phone camera to grab the list — no app or account needed. Or copy it and text it over.'
                    : 'This list is too long to scan as a QR code — the squares would be too small for a camera to read. Copy it or send it through the share sheet instead.'}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {canShare() && <button type="button" className="btn btn-primary" onClick={share}>Share…</button>}
                  <button type="button" className={`btn ${canShare() ? 'btn-ghost' : 'btn-primary'}`} onClick={copy}>
                    {copied ? 'Copied ✓' : 'Copy list'}
                  </button>
                </div>
              </div>
            </div>
            <div
              className="share-list-text"
              style={{
                whiteSpace: 'pre-wrap',
                border: '1px solid var(--hair)',
                borderRadius: 12,
                padding: '10px 14px',
                fontWeight: 600,
                fontSize: 14,
                lineHeight: 1.6,
              }}
            >
              {text}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
