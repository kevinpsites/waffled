// Tapping a By-person column or Year-ring wedge opens this — those views are
// MONTH-scoped (a segment is a whole month), so this pulls that month's total +
// per-member breakdown from `stats`, not a single synthesized day.
import type { GoalDetail, GoalParticipant } from '../../lib/api'
import { fmtGoalNum } from '../../lib/api'
import type { GoalStats } from '../../lib/goalStats'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function MonthDetailPopover({
  year,
  month,
  goal,
  stats,
  personMap,
  onClose,
}: {
  year: number
  month: number // 0-indexed
  goal: GoalDetail
  stats: GoalStats
  personMap: Map<string, GoalParticipant>
  onClose: () => void
}) {
  const total = stats.byMonth[month] ?? 0
  const perMember = stats.byMonthPerMember[month] ?? {}
  const memberIds = Object.keys(perMember).filter((id) => perMember[id] > 0)
  // Parsed directly out of the household-tz dateKey string — NOT `new
  // Date(r.loggedAt)`, which reads the year/month in the viewing device's own
  // timezone and could disagree with which month the entry is actually bucketed
  // under (the same mismatch DayDetailPopover had).
  const matches = goal.recent.filter((r) => {
    const [y, m] = r.dateKey.split('-').map(Number)
    return y === year && m - 1 === month
  })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="card-h" style={{ marginBottom: 4 }}>{MONTH_NAMES[month]} {year}</div>
        <div className="tiny muted" style={{ marginBottom: 14 }}>
          {fmtGoalNum(total)}{goal.unit ? ` ${goal.unit}` : ''} logged
        </div>

        {total === 0 && matches.length === 0 && (
          <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 0' }}>No activity logged this month.</div>
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

        {matches.length === 0 && memberIds.length > 0 && (
          <div>
            {memberIds.map((pid) => {
              const p = personMap.get(pid)
              return (
                <div key={pid} className="detail-hours-row">
                  <div className="av sm" style={{ background: `${p?.colorHex ?? '#A6A29B'}22` }}>{p?.avatarEmoji ?? '🙂'}</div>
                  <div className="detail-hours-name">{p?.name ?? 'Someone'}</div>
                  <div className="tiny muted detail-hours-val">{fmtGoalNum(perMember[pid])}{goal.unit ? ` ${goal.unit}` : ''}</div>
                </div>
              )
            })}
            <div className="tiny muted" style={{ marginTop: 10 }}>
              Individual entries aren't kept in the recent log this far back — showing the month's totals only.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
