import { useEffect, useState, type FormEvent } from 'react'
import { googlePhotosApi, useGoogleImport } from '../../lib/api'
import { ApiSendError } from '../../lib/api/client'
import { AlbumPicker } from './AlbumPicker'

// Import from Google Photos into one album. Google's picker opens in its own tab
// (the /autoclose suffix closes it when the user taps Done); this dialog polls the
// import until the server has copied the photos in.
export function GooglePhotosImportModal({
  albums,
  initialAlbum = '',
  onClose,
  onImported,
}: {
  albums: string[]
  /** Pre-fills the album, for a re-sync. */
  initialAlbum?: string
  onClose: () => void
  onImported: (album: string) => void
}) {
  const [album, setAlbum] = useState(initialAlbum)
  const [importId, setImportId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<{ message: string; enableUrl?: string } | null>(null)
  const imp = useGoogleImport(importId)

  useEffect(() => {
    if (imp?.status === 'done') onImported(imp.album)
  }, [imp?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start(e: FormEvent) {
    e.preventDefault()
    const name = album.trim()
    if (!name || busy) return
    // Open the tab inside the click so popup blockers allow it, then point it at
    // the picker once the session exists.
    const tab = window.open('', '_blank')
    setBusy(true)
    setErr(null)
    try {
      const created = await googlePhotosApi.startGoogleImport(name)
      if (tab) tab.location.href = `${created.pickerUri}/autoclose`
      else window.location.assign(created.pickerUri)
      setImportId(created.id)
    } catch (ex) {
      tab?.close()
      if (ex instanceof ApiSendError && ex.body?.message) {
        const enableUrl = typeof ex.body.enableUrl === 'string' ? ex.body.enableUrl : undefined
        setErr({ message: ex.body.message, enableUrl })
      } else {
        setErr({ message: ex instanceof Error ? ex.message : 'Could not open Google Photos' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Import from Google Photos" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Import from Google Photos</div>
        {!imp ? (
          <form onSubmit={start}>
            <div className="tiny muted" style={{ marginBottom: 14, fontWeight: 600 }}>
              {initialAlbum ? `Re-sync “${initialAlbum}”: pick the album again in Google Photos and only the photos Waffled doesn’t have yet are copied. ` : null}
              Name the album these photos go into here. Your Google albums appear in the next step, inside Google Photos, where you can open one and select its photos.
            </div>
            <label className="ap-field-label" style={{ marginBottom: 18 }}>
              Waffled album
              {albums.length > 0 ? (
                <AlbumPicker value={album} onChange={setAlbum} albums={albums} />
              ) : (
                <input className="field" placeholder="e.g. Beach 2024" value={album} onChange={(e) => setAlbum(e.target.value)} autoFocus />
              )}
            </label>
            {err && (
              <div className="tiny" style={{ color: 'var(--danger)', fontWeight: 700, marginBottom: 12 }}>
                {err.message}
                {err.enableUrl && (
                  <>
                    {' '}
                    <a href={err.enableUrl} target="_blank" rel="noreferrer">Enable it in Google Cloud ↗</a>
                  </>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!album.trim() || busy}>Open Google Photos</button>
            </div>
          </form>
        ) : (
          <div>
            <div className="tiny muted" style={{ fontWeight: 600, margin: '8px 0 18px' }}>{importMessage(imp)}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              {(imp.status === 'expired' || imp.status === 'failed') && (
                <button type="button" className="btn btn-ghost" onClick={() => setImportId(null)}>Try again</button>
              )}
              {imp.status === 'picking' && (
                <a className="btn btn-ghost" href={`${imp.pickerUri}/autoclose`} target="_blank" rel="noreferrer">Reopen picker</a>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {imp.status === 'done' ? 'Done' : 'Close'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function importMessage(imp: { status: string; album: string; importedCount: number; skippedCount: number; error: string | null }): string {
  switch (imp.status) {
    case 'picking':
      return 'Pick photos in the Google Photos tab, then tap Done there. This window updates on its own.'
    case 'importing':
      return `Copying photos into “${imp.album}”… ${imp.importedCount} so far.`
    case 'done': {
      const skipped = imp.skippedCount ? ` (${imp.skippedCount} skipped — videos or already imported)` : ''
      return `Added ${imp.importedCount} ${imp.importedCount === 1 ? 'photo' : 'photos'} to “${imp.album}”${skipped}. Photos added in Google later need another re-sync.`
    }
    case 'expired':
      return 'The Google Photos session ran out before anything was picked.'
    default:
      return `The import failed${imp.error ? `: ${imp.error}` : ''}.`
  }
}
