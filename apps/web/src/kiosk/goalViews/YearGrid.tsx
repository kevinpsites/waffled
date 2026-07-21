// Year — Contribution grid (GitHub-style). Consistency at a glance for the whole
// calendar year so far. Scoped to the current calendar year (Jan 1 -> today),
// clipped to the goal's own start if it began later in the year.
import { addDaysKey, diffDaysKey, heat, parseLocalDateKey, toLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CELL = 13
const GAP = 3.5

export function YearGrid({ goal, stats, onDayClick, headerRight }: DataViewProps) {
  const today = stats.today
  const todayDate = parseLocalDateKey(today)
  const jan1 = toLocalDateKey(new Date(todayDate.getFullYear(), 0, 1))
  const viewStart = stats.startDate > jan1 ? stats.startDate : jan1
  const startSun = addDaysKey(jan1, -parseLocalDateKey(jan1).getDay())

  const weeks: string[][] = []
  let cursor = startSun
  while (cursor <= today) {
    weeks.push(Array.from({ length: 7 }, (_, r) => addDaysKey(cursor, r)))
    cursor = addDaysKey(cursor, 7)
  }
  const yearMax = stats.yearMax || 1

  let monthLabelSeen = -1
  const monthLabels: Array<{ x: number; label: string }> = []
  weeks.forEach((col, ci) => {
    const m = parseLocalDateKey(col[0]).getMonth()
    const d = parseLocalDateKey(col[0]).getDate()
    if (m !== monthLabelSeen && d <= 7) {
      monthLabels.push({ x: ci * (CELL + GAP), label: MONTH_NAMES[m] })
      monthLabelSeen = m
    }
  })

  const squares: Array<{ x: number; y: number; dateKey: string; total: number }> = []
  weeks.forEach((col, ci) => {
    col.forEach((dateKey, ri) => {
      if (dateKey < viewStart || dateKey > today) return
      squares.push({ x: ci * (CELL + GAP), y: ri * (CELL + GAP), dateKey, total: stats.dayEntry(dateKey).total })
    })
  })
  const gw = weeks.length * (CELL + GAP)
  const gh = 7 * (CELL + GAP)

  // stats.activeDays is a lifetime count (no lower date bound on the query behind
  // it) but this grid only spans the current calendar year — using the lifetime
  // count against an in-year day span could push "% of days" past 100% and made
  // the header's "N active days" describe a number bigger than what's plotted.
  const activeDaysInViewCount = squares.filter((s) => s.total > 0).length
  const activeDaysInView = Math.max(1, diffDaysKey(today, viewStart) + 1)
  const pct = Math.round((activeDaysInViewCount / activeDaysInView) * 100)

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">The whole year</div>
          <div className="gdv-head-sub">{activeDaysInViewCount} active days · every square is a day</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <svg viewBox={`0 0 ${gw} ${gh + 16}`} width="100%" style={{ maxWidth: gw }}>
        <g transform="translate(0,4)">
          {monthLabels.map((m) => (
            <text key={m.label + m.x} x={m.x} y={9} fontSize={10} fontWeight={700} fill="var(--ink-3)">{m.label}</text>
          ))}
        </g>
        <g transform="translate(0,16)">
          {squares.map((s) => (
            <rect
              key={s.dateKey}
              x={s.x}
              y={s.y}
              width={CELL}
              height={CELL}
              rx={3}
              fill={s.total > 0 ? heat(s.total / yearMax) : 'var(--panel)'}
              style={{ cursor: 'pointer' }}
              onClick={() => onDayClick(s.dateKey)}
            >
              <title>{s.dateKey} · {s.total}{goal.unit ? ` ${goal.unit}` : ''}</title>
            </rect>
          ))}
        </g>
      </svg>
      <div className="gdv-footer">
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v" style={{ color: 'var(--primary)' }}>🔥 {stats.currentStreak}</div><div className="gdv-stat-l">current streak</div></div>
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v">{stats.longestStreak}</div><div className="gdv-stat-l">longest streak</div></div>
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v">{activeDaysInViewCount}</div><div className="gdv-stat-l">active days</div></div>
        <div className="gdv-stat"><div className="wf-serif gdv-stat-v">{pct}%</div><div className="gdv-stat-l">of days</div></div>
        <div className="gdv-footer-right gdv-legend-row">
          <span className="tiny muted">Less</span>
          <div className="gdv-legend">
            {[0.12, 0.4, 0.7, 1].map((t) => <span key={t} className="gdv-legend-sw" style={{ width: 13, height: 13, background: heat(t) }} />)}
          </div>
          <span className="tiny muted">More</span>
        </div>
      </div>
    </div>
  )
}
