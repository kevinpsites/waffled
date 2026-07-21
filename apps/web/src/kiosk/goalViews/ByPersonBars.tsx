// By person — stacked columns by month. Who is driving the family total.
import { fmtGoalNum } from '../../lib/api'
import { parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BAR_H = 190

export function ByPersonBars({ goal, stats, personMap, onMonthClick, headerRight }: DataViewProps) {
  const year = parseLocalDateKey(stats.today).getFullYear()
  const currentMonth = parseLocalDateKey(stats.today).getMonth()
  const months = Array.from({ length: currentMonth + 1 }, (_, m) => m)
  const monthMax = Math.max(1, ...stats.byMonth.slice(0, currentMonth + 1))

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">By month · by person</div>
          <div className="gdv-head-sub">who is driving the family total</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-byperson-cols">
        {months.map((m) => {
          const perMember = stats.byMonthPerMember[m]
          const ids = Object.keys(perMember).filter((id) => perMember[id] > 0)
          return (
            <button
              key={m}
              type="button"
              className="gdv-byperson-col"
              onClick={() => onMonthClick(year, m)}
            >
              <span className="wf-serif gdv-byperson-total">{fmtGoalNum(stats.byMonth[m])}</span>
              <div className="gdv-byperson-bar">
                {ids.map((id) => (
                  <div
                    key={id}
                    className="gdv-byperson-seg"
                    style={{ height: `${(perMember[id] / monthMax) * BAR_H}px`, background: personMap.get(id)?.colorHex ?? 'var(--ink-3)' }}
                    title={`${personMap.get(id)?.name ?? ''} ${fmtGoalNum(perMember[id])}`}
                  />
                ))}
              </div>
              <span className="tiny muted gdv-byperson-lbl">{MONTH_NAMES[m]}</span>
            </button>
          )
        })}
      </div>
      <div className="gdv-byperson-chips">
        {[...personMap.values()].map((p) => (
          <div key={p.personId} className="gdv-byperson-chip">
            <span className="gdv-dot" style={{ width: 12, height: 12, background: p.colorHex ?? 'var(--ink-3)' }} />
            <div>
              <div className="tiny gdv-byperson-chip-name">{p.name}</div>
              <div className="wf-serif gdv-byperson-chip-total">
                {fmtGoalNum(stats.byPerson[p.personId] ?? 0)}
                {goal.unit ? <span className="tiny muted"> {goal.unit}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
