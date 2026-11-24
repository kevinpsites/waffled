import { useCallback, useEffect, useState } from 'react'
import { trackersApi, type Tracker } from '../../lib/api/trackers'
import { useRefetchOn } from '../../lib/api/bus'
import { useHousehold } from '../../lib/api/persons'
import { formatLastTime } from '../../lib/trackers-format'
import { TrackerModal } from './TrackerModal'
import { TrackerHistory } from './TrackerHistory'

// Same fallback as Calendar: household zone, else the browser's.
const fallbackTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function TrackersPanel() {
  const { household, person } = useHousehold()
  const tz = household?.timezone || fallbackTz()
  // Mirrors the server rule for creating/updating/archiving trackers.
  const canManage = !!person && (person.isAdmin || person.memberType === 'adult')
  const [all, setAll] = useState<Tracker[] | null>(null)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<{ tracker?: Tracker } | null>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['trackers'], refresh)

  useEffect(() => {
    let alive = true
    trackersApi.list(true)
      .then((d) => { if (alive) { setAll(d.trackers ?? []); setError(false) } })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [nonce])

  const active = (all ?? []).filter((t) => !t.archivedAt)
  const archived = (all ?? []).filter((t) => t.archivedAt)
  const viewing = all?.find((t) => t.id === historyId)
  if (viewing) return <TrackerHistory tracker={viewing} tz={tz} onBack={() => setHistoryId(null)} />

  const row = (t: Tracker, isArchived: boolean) => (
    <div key={t.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 8, opacity: isArchived ? 0.6 : 1 }}>
      <span style={{ fontSize: 22 }}>{t.emoji ?? '⏱️'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{t.title}</div>
        <div className="tiny muted">{formatLastTime(t.lastEntry, tz)}</div>
      </div>
      <button type="button" className="pill" onClick={() => setHistoryId(t.id)}>History</button>
      {canManage && !isArchived && <button type="button" className="pill" onClick={() => setModal({ tracker: t })}>Edit</button>}
      {canManage && !isArchived && <button type="button" className="pill" onClick={() => void trackersApi.update(t.id, { archived: true })}>Archive</button>}
      {canManage && isArchived && <button type="button" className="pill" onClick={() => void trackersApi.update(t.id, { archived: false })}>Unarchive</button>}
    </div>
  )

  return (
    <div style={{ padding: '0 30px 30px' }}>
      {canManage && (
        <button type="button" className="btn btn-primary" style={{ marginBottom: 12 }} onClick={() => setModal({})}>Add tracker</button>
      )}
      {error && <div className="muted">Couldn't load trackers — try reloading.</div>}
      {all === null && !error && <div className="muted">Loading…</div>}
      {all && active.length === 0 && <div className="muted">No trackers yet.</div>}
      {active.map((t) => row(t, false))}
      {archived.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="pill" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            Archived ({archived.length})
          </button>
          <div style={{ marginTop: 8 }}>{showArchived && archived.map((t) => row(t, true))}</div>
        </div>
      )}
      {modal && <TrackerModal tracker={modal.tracker} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  )
}
