// Month — Calendar heatmap. A familiar month grid where shade = hours logged that
// day. Navigable back/forward — clamped so you can't page past the current month.
import { useState } from 'react'
import { fmtGoalNum } from '../../lib/api'
import { heat, HEAT_DARK_THRESHOLD, toLocalDateKey, parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const WEEKDAY_HEADS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const HEAT_STOPS = [0.12, 0.35, 0.6, 0.85, 1]

export function MonthHeatmap({ goal, stats, personMap, onDayClick, headerRight }: DataViewProps) {
  const [monthOffset, setMonthOffset] = useState(0)
  const todayDate = parseLocalDateKey(stats.today)
  const shown = new Date(todayDate.getFullYear(), todayDate.getMonth() + monthOffset, 1)
  const year = shown.getFullYear()
  const month = shown.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = new Date(year, month, 1).getDay()
  const canGoForward = monthOffset < 0

  let monthTotal = 0
  let monthMax = 1
  let bestDay: { dateKey: string; total: number } | null = null
  const dayInfo = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1
    const dateKey = toLocalDateKey(new Date(year, month, day))
    const future = dateKey > stats.today
    const entry = stats.dayEntry(dateKey)
    if (!future) {
      monthTotal += entry.total
      if (entry.total > monthMax) monthMax = entry.total
      if (entry.total > 0 && (!bestDay || entry.total > bestDay.total)) bestDay = { dateKey, total: entry.total }
    }
    return { day, dateKey, future, entry }
  })

  const cells = dayInfo.map(({ day, dateKey, future, entry }) => {
    const intensity = entry.total > 0 ? entry.total / monthMax : 0
    const dark = intensity > HEAT_DARK_THRESHOLD
    const memberIds = Object.keys(entry.perMember)
    return (
      <button
        key={dateKey}
        type="button"
        className={`gdv-month-cell${future ? ' future' : ''}`}
        style={{ background: future ? 'transparent' : entry.total > 0 ? heat(intensity) : 'var(--panel)' }}
        onClick={() => onDayClick(dateKey)}
      >
        <span className="gdv-month-daynum" style={{ color: future ? 'var(--ink-3)' : dark ? '#fff' : 'var(--ink-2)' }}>{day}</span>
        {!future && entry.total > 0 && (
          <span className="wf-serif gdv-month-total" style={{ color: dark ? '#fff' : 'var(--ink)' }}>{fmtGoalNum(entry.total)}</span>
        )}
        {memberIds.length > 0 && (
          <div className="gdv-dot-row gdv-month-dots">
            {memberIds.map((pid) => (
              <span key={pid} className="gdv-dot" style={{ background: dark ? 'rgba(255,255,255,.9)' : personMap.get(pid)?.colorHex ?? 'var(--ink-3)' }} />
            ))}
          </div>
        )}
      </button>
    )
  })

  return (
    <div>
      <div className="gdv-head">
        <div className="gdv-month-nav">
          <button type="button" className="gdv-month-navbtn" aria-label="Previous month" onClick={() => setMonthOffset((o) => o - 1)}>‹</button>
          <div>
            <div className="gdv-head-t">{MONTH_NAMES[month]}{year !== todayDate.getFullYear() ? ` ${year}` : ''}</div>
            <div className="gdv-head-sub">{fmtGoalNum(monthTotal)}{goal.unit ? ` ${goal.unit}` : ''} this month · shade = {goal.unit || 'activity'} logged</div>
          </div>
          <button type="button" className="gdv-month-navbtn" aria-label="Next month" disabled={!canGoForward} onClick={() => setMonthOffset((o) => Math.min(0, o + 1))}>›</button>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-month-grid gdv-month-heads">
        {WEEKDAY_HEADS.map((h, i) => <div key={i} className="gdv-month-head">{h}</div>)}
      </div>
      <div className="gdv-month-grid">
        {Array.from({ length: lead }, (_, i) => <div key={`lead-${i}`} className="gdv-month-lead" />)}
        {cells}
      </div>
      <div className="gdv-footer">
        <span className="tiny muted">Less</span>
        <div className="gdv-legend">
          {HEAT_STOPS.map((t) => <span key={t} className="gdv-legend-sw" style={{ background: heat(t) }} />)}
        </div>
        <span className="tiny muted">More</span>
        {bestDay && (
          <span className="tiny muted gdv-footer-right">
            Best day · <b className="wf-serif">{fmtGoalNum((bestDay as { total: number }).total)}{goal.unit ? ` ${goal.unit}` : ''}</b>
          </span>
        )}
      </div>
    </div>
  )
}
