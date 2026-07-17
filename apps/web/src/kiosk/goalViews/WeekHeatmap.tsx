// Week — Heatmap strip (Treatment A, the chosen week treatment). Only what was
// done is drawn; rest days sit light and quiet — never an "empty bar = failure".
import { fmtGoalNum } from '../../lib/api'
import { addDaysKey, heat, HEAT_DARK_THRESHOLD, parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function fmtMonthDay(dateKey: string): string {
  return parseLocalDateKey(dateKey).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function WeekHeatmap({ goal, stats, personMap, onDayClick, headerRight }: DataViewProps) {
  const today = stats.today
  const weekKeys = Array.from({ length: 7 }, (_, i) => addDaysKey(today, i - 6))
  const weekMax = stats.weekMax || 1
  const weekTotal = weekKeys.reduce((s, k) => s + stats.dayEntry(k).total, 0)
  const prevWeekTotal = Array.from({ length: 7 }, (_, i) => addDaysKey(today, i - 13)).reduce(
    (s, k) => s + stats.dayEntry(k).total,
    0
  )
  const delta = Math.round((weekTotal - prevWeekTotal) * 10) / 10

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">This week</div>
          <div className="gdv-head-sub">{fmtMonthDay(weekKeys[0])} – {fmtMonthDay(today)} · the rhythm of your week</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-week">
        {weekKeys.map((dateKey) => {
          const entry = stats.dayEntry(dateKey)
          const isToday = dateKey === today
          const intensity = entry.total > 0 ? entry.total / weekMax : 0
          const dark = intensity > HEAT_DARK_THRESHOLD
          const dow = new Date(dateKey + 'T00:00:00').getDay()
          const memberIds = Object.keys(entry.perMember)
          return (
            <button key={dateKey} type="button" className="gdv-week-cell-btn" onClick={() => onDayClick(dateKey)}>
              <div className="gdv-week-cell" style={{ background: entry.total > 0 ? heat(intensity) : 'var(--panel)' }}>
                <span className="wf-serif gdv-week-num" style={{ color: dark ? '#fff' : entry.total > 0 ? 'var(--ink)' : 'var(--ink-3)' }}>
                  {entry.total > 0 ? fmtGoalNum(entry.total) : '·'}
                </span>
                {memberIds.length > 0 && (
                  <div className="gdv-dot-row">
                    {memberIds.map((pid) => (
                      <span
                        key={pid}
                        className="gdv-dot"
                        style={{ background: dark ? 'rgba(255,255,255,.9)' : personMap.get(pid)?.colorHex ?? 'var(--ink-3)' }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <span className="gdv-week-lbl" style={{ color: isToday ? 'var(--primary)' : 'var(--ink-3)' }}>
                {WEEKDAY[dow]}
              </span>
            </button>
          )
        })}
      </div>
      <div className="gdv-summary">
        <span className="wf-serif gdv-summary-n">{fmtGoalNum(weekTotal)}</span>
        <span className="tiny muted gdv-summary-t">
          {goal.unit ? ` ${goal.unit} ` : ' '}this week
          {prevWeekTotal > 0 || weekTotal > 0 ? (
            <>
              {' '}
              · <b style={{ color: delta >= 0 ? 'var(--success)' : 'var(--danger)' }}>{delta >= 0 ? '+' : ''}{fmtGoalNum(delta)}</b> vs last
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}
