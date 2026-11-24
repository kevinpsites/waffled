import { useRef, useState } from 'react'
import { trackersApi, useTrackers, type Tracker } from '../../lib/api/trackers'
import { useHousehold, usePersons } from '../../lib/api/persons'
import { formatLastTime } from '../../lib/trackers-format'
import { PersonPickModal } from './PersonPickModal'
import { UndoToast } from './UndoToast'
import '../../styles/trackers.css'

// Today card for trackers: one big tile per tracker, one tap logs it. Renders nothing
// when there are no trackers, like RhythmsCard on a quiet day.
export function TrackersCard() {
  const { trackers } = useTrackers()
  const { household } = useHousehold()
  const { persons } = usePersons()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [picking, setPicking] = useState<Tracker | null>(null)
  const [toast, setToast] = useState<{ title: string; entryId: string; n: number } | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [undoFailed, setUndoFailed] = useState(false)
  // Tiles with a log in flight (or the Ask-who picker open); taps on them are ignored so a
  // slow response can't turn an impatient re-tap into a ghost duplicate entry.
  const busy = useRef(new Set<string>())

  if (!trackers || trackers.length === 0) return null

  async function log(t: Tracker, personId?: string) {
    setFailedId(null)
    setUndoFailed(false)
    busy.current.add(t.id)
    try {
      const { entry } = await trackersApi.log(t.id, personId ? { personId } : {})
      // n re-keys the toast so a second tap restarts its timer and Undo targets the latest entry.
      setToast((prev) => ({ title: t.title, entryId: entry.id, n: (prev?.n ?? 0) + 1 }))
    } catch {
      setFailedId(t.id)
    } finally {
      busy.current.delete(t.id)
    }
  }

  function undo(entryId: string) {
    trackersApi.deleteEntry(entryId).catch((e: unknown) => {
      // 404 means the entry is already gone, which is what Undo wanted anyway.
      if ((e as { status?: number } | null)?.status !== 404) setUndoFailed(true)
    })
  }

  function tap(t: Tracker) {
    if (busy.current.has(t.id)) return
    if (t.askPerson) {
      busy.current.add(t.id)
      setPicking(t)
    } else void log(t)
  }

  return (
    <div className="card trk-card">
      <div className="card-h trk-h">Trackers</div>
      <div className="trk-list">
        {trackers.map((t) => (
          <div key={t.id}>
            <button type="button" className="trk-tile" onClick={() => tap(t)}>
              <span className="trk-emoji" aria-hidden>{t.emoji ?? '⏱️'}</span>
              <span className="trk-main">
                <span className="trk-title">{t.title}</span>
                <span className="tiny muted">{formatLastTime(t.lastEntry, tz)}</span>
              </span>
            </button>
            {failedId === t.id && (
              <div className="trk-failed" role="status">That didn't go through — try again.</div>
            )}
          </div>
        ))}
      </div>
      {picking && (
        <PersonPickModal
          title={`Who is this for? (${picking.title})`}
          people={persons}
          onPick={(id) => { const t = picking; setPicking(null); void log(t, id) }}
          onCancel={() => { busy.current.delete(picking.id); setPicking(null) }}
        />
      )}
      {undoFailed && (
        <div className="trk-failed" role="status">Undo didn't go through — check History.</div>
      )}
      {toast && (
        <UndoToast
          key={toast.n}
          message={`Logged ${toast.title}`}
          onUndo={() => undo(toast.entryId)}
          onDone={() => setToast((cur) => (cur && cur.n === toast.n ? null : cur))}
        />
      )}
    </div>
  )
}
