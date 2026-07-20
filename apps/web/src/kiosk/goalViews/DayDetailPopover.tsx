// Tapping a day/segment cell opens this — the day's log entries, reusing the
// existing Recent-activity `.logrow` styling. `recent` only keeps the last 12
// grouped entries, so an older tapped day falls back to the per-member total
// breakdown from the day-bucketed activity instead of raw entries.
import type { GoalDetail, GoalParticipant } from '../../lib/api'
import { fmtGoalNum } from '../../lib/api'
import type { DayEntry } from '../../lib/goalStats'

export function DayDetailPopover({
  dateKey,
  dayEntry,
  goal,
  personMap,
  onClose,
}: {
  dateKey: string
  dayEntry: DayEntry
  goal: GoalDetail
  personMap: Map<string, GoalParticipant>
  onClose: () => void
}) {
  const label = new Date(dateKey + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  // `dateKey` on each entry is the household-timezone day (matching the total
  // shown above, which comes from the same household-tz bucketing server-side) —
  // NOT re-derived from `loggedAt` in the viewing device's own timezone.
  const matches = goal.recent.filter((r) => r.dateKey === dateKey)
  const memberIds = Object.keys(dayEntry.perMember)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="card-h" style={{ marginBottom: 4 }}>{label}</div>
        <div className="tiny muted" style={{ marginBottom: 14 }}>
          {fmtGoalNum(dayEntry.total)}{goal.unit ? ` ${goal.unit}` : ''} logged
        </div>

        {dayEntry.total === 0 && matches.length === 0 && (
          <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 0' }}>No activity logged this day.</div>
        )}

        {matches.length > 0 &&
          matches.map((r) => (
            <div key={r.id} className="logrow">
              {r.participants.length > 0 ? (
                <div className="avstack">
                  {r.participants.map((p) => (
                    <div key={p.personId ?? p.name} className="av sm" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</div>
                  ))}
                </div>
              ) : (
                <div className="av sm" style={{ background: '#A6A29B22' }}>🙂</div>
              )}
              <div className="lwhat">{r.note || 'Logged progress'}</div>
              <div className="lamt">+{fmtGoalNum(r.amount)}{goal.unit ? ` ${goal.unit}` : ''}</div>
            </div>
          ))}

        {matches.length === 0 && dayEntry.total > 0 && memberIds.length > 0 && (
          <div>
            {memberIds.map((pid) => {
              const p = personMap.get(pid)
              return (
                <div key={pid} className="detail-hours-row">
                  <div className="av sm" style={{ background: `${p?.colorHex ?? '#A6A29B'}22` }}>{p?.avatarEmoji ?? '🙂'}</div>
                  <div className="detail-hours-name">{p?.name ?? 'Someone'}</div>
                  <div className="tiny muted detail-hours-val">{fmtGoalNum(dayEntry.perMember[pid])}{goal.unit ? ` ${goal.unit}` : ''}</div>
                </div>
              )
            })}
            <div className="tiny muted" style={{ marginTop: 10 }}>
              Individual entries aren't kept in the recent log this far back — showing the day's totals only.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
