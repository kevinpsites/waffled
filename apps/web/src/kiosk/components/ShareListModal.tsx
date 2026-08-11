import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { formatShareList, type ShareListItem } from './share-list'

// "Share list" — the grocery handoff. Shows the board's unchecked items as a
// clean aisle-grouped text list with copy, navigator.share, and a QR code that
// encodes the text ITSELF (not a link), so a phone camera grabs the whole list
// with no app, no account, and no server round-trip.

const canShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

export function ShareListModal({ items, onClose }: { items: ShareListItem[]; onClose: () => void }) {
  const text = formatShareList(items)
  const count = items.filter((i) => !i.checked).length
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!text) return
    QRCode.toDataURL(text, { width: 240, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null))
  }, [text])

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
              {qr && <img src={qr} alt="Scan to grab the list" width={160} height={160} style={{ borderRadius: 12 }} />}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>{count} item{count === 1 ? '' : 's'} to get</div>
                <div className="tiny muted" style={{ marginBottom: 10 }}>
                  Scan with a phone camera to grab the list — no app or account needed. Or copy it and text it over.
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
