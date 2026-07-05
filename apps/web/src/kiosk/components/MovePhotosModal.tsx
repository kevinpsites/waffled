import { useState, type FormEvent } from 'react'
import { AlbumPicker } from './AlbumPicker'

// Bulk "move to album" dialog for the Photos select mode. Picks an existing album or
// a new one (empty = remove from any album) and reports it to onMove. Matches the app
// modal chrome (.modal-overlay / .modal-card) used by ConfirmDialog.

export function MovePhotosModal({
  count,
  albums,
  onMove,
  onClose,
}: {
  count: number
  albums: string[]
  onMove: (album: string) => void | Promise<void>
  onClose: () => void
}) {
  const [album, setAlbum] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onMove(album.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ maxWidth: 400 }}>
        <div className="wf-serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 12 }}>
          Move {count === 1 ? 'photo' : `${count} photos`} to…
        </div>
        <label className="ap-field-label" style={{ marginBottom: 18 }}>
          Album
          <AlbumPicker value={album} onChange={setAlbum} albums={albums} />
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Moving…' : 'Move'}</button>
        </div>
      </form>
    </div>
  )
}
