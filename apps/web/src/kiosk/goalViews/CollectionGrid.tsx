// Count's signature view — a collection grid. Progress reads as "the shelf fills
// up," not a percentage bar: `target` slots, the first `done` filled.
import { fmtGoalNum } from '../../lib/api'
import { heat, parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function CollectionGrid({ goal, stats, headerRight }: DataViewProps) {
  const target = goal.target ?? 0
  const done = Math.round(goal.totalProgress)
  const currentMonth = parseLocalDateKey(stats.today).getMonth()
  const monthMax = Math.max(1, ...stats.byMonth.slice(0, currentMonth + 1))

  const slots = Array.from({ length: Math.max(target, done) }, (_, i) => {
    const filled = i < done
    return (
      <div
        key={i}
        className={`gdv-collection-slot${filled ? ' filled' : ''}`}
        style={filled ? { background: heat(0.42 + 0.5 * ((i * 3) % 5) / 5) } : undefined}
      />
    )
  })

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">{goal.title}</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-collection-grid">{slots}</div>
      <div className="tiny muted gdv-collection-cap">
        <b className="wf-serif" style={{ fontSize: 15 }}>{done}</b> of {fmtGoalNum(target)}
        {stats.projectedFinish && (
          <> · <span style={{ color: 'var(--success)' }}>on pace for {MONTH_NAMES[parseLocalDateKey(stats.projectedFinish).getMonth()]}</span></>
        )}
      </div>
      <div className="tiny muted gdv-collection-permonth-lbl">{(goal.unit || 'items').toUpperCase()} PER MONTH</div>
      <div className="gdv-collection-permonth">
        {stats.byMonth.slice(0, currentMonth + 1).map((v, i) => (
          <div key={i} className="gdv-collection-permonth-col">
            <div className="gdv-collection-permonth-bar" style={{ height: `${(v / monthMax) * 40}px` }} />
            <span className="tiny muted">{MONTH_NAMES[i][0]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
