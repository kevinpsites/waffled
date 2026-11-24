import { useState } from 'react'
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

  if (!trackers || trackers.length === 0) return null

  async function log(t: Tracker, personId?: string) {
    setFailedId(null)
    try {
      const { entry } = await trackersApi.log(t.id, personId ? { personId } : {})
      // n re-keys the toast so a second tap restarts its timer and Undo targets the latest entry.
      setToast((prev) => ({ title: t.title, entryId: entry.id, n: (prev?.n ?? 0) + 1 }))
    } catch {
      setFailedId(t.id)
    }
  }

  function tap(t: Tracker) {
    if (t.askPerson) setPicking(t)
    else void log(t)
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
          onCancel={() => setPicking(null)}
        />
      )}
      {toast && (
        <UndoToast
          key={toast.n}
          message={`Logged ${toast.title}`}
          onUndo={() => { trackersApi.deleteEntry(toast.entryId).catch(() => {}) }}
          onDone={() => setToast((cur) => (cur && cur.n === toast.n ? null : cur))}
        />
      )}
    </div>
  )
}
