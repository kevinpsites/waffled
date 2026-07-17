// Habit's signature view — a consistency dot-calendar. Did you show up? A month
// of hit/miss dots plus streak stats. (The 7-dot Week strip is the compact variant —
// see WeekHeatmap, offered alongside this for habit goals.)
import { toLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function ConsistencyCalendar({ goal, stats, onDayClick, headerRight }: DataViewProps) {
  const todayDate = new Date(stats.today + 'T00:00:00')
  const year = todayDate.getFullYear()
  const month = todayDate.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = new Date(year, month, 1).getDay()

  let hitsThisMonth = 0
  const cells = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1
    const dateKey = toLocalDateKey(new Date(year, month, day))
    const future = dateKey > stats.today
    const hit = !future && stats.dayEntry(dateKey).total > 0
    if (hit) hitsThisMonth++
    return (
      <button
        key={dateKey}
        type="button"
        className={`gdv-consistency-cell${hit ? ' hit' : ''}${future ? ' future' : ''}`}
        onClick={() => onDayClick(dateKey)}
      >
        {future ? day : ''}
      </button>
    )
  })

  const pct = Math.round((hitsThisMonth / todayDate.getDate()) * 100)

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">{MONTH_NAMES[month]}</div>
          <div className="gdv-head-sub">{goal.title}</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-month-grid gdv-consistency-grid">
        {Array.from({ length: lead }, (_, i) => <div key={`lead-${i}`} />)}
        {cells}
      </div>
      <div className="gdv-footer">
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v" style={{ color: 'var(--primary)' }}>🔥 {stats.currentStreak}</div><div className="gdv-stat-l">current</div></div>
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v">{stats.longestStreak}</div><div className="gdv-stat-l">longest</div></div>
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v">{pct}%</div><div className="gdv-stat-l">this month</div></div>
      </div>
    </div>
  )
}
