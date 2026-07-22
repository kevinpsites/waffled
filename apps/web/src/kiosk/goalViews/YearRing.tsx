// Year ring — radial polar bars. A glanceable, decorative "year so far": each
// wedge is a month, a longer filled arc = more logged that month.
import { fmtGoalNum } from '../../lib/api'
import { heat, parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const S = 300
const CX = S / 2
const CY = S / 2
const R0 = 64
const R1 = 132
const GAP_DEG = 3

function polar(r: number, angleDeg: number): [number, number] {
  const t = ((angleDeg - 90) * Math.PI) / 180
  return [CX + r * Math.cos(t), CY + r * Math.sin(t)]
}

function sectorPath(rr0: number, rr1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(rr1, a0)
  const [x1, y1] = polar(rr1, a1)
  const [x2, y2] = polar(rr0, a1)
  const [x3, y3] = polar(rr0, a0)
  const largeArc = a1 - a0 > 180 ? 1 : 0
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rr1},${rr1} 0 ${largeArc} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${rr0},${rr0} 0 ${largeArc} 0 ${x3.toFixed(1)},${y3.toFixed(1)} Z`
}

export function YearRing({ goal, stats, onMonthClick, headerRight }: DataViewProps) {
  const year = parseLocalDateKey(stats.today).getFullYear()
  const currentMonth = parseLocalDateKey(stats.today).getMonth()
  const monthMax = Math.max(1, ...stats.byMonth.slice(0, currentMonth + 1))
  const total = stats.byMonth.reduce((s, v) => s + v, 0)
  const target = goal.target ?? 0

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">The year in a ring</div>
          <div className="gdv-head-sub">each wedge is a month — longer = more {goal.unit || 'logged'}</div>
        </div>
        {headerRight && <div className="gdv-head-grow">{headerRight}</div>}
      </div>
      <div className="gdv-ring-row">
        <svg viewBox={`0 0 ${S} ${S}`} width={300} style={{ flex: 'none' }}>
          {Array.from({ length: 12 }, (_, m) => {
            const a0 = m * 30 + GAP_DEG / 2
            const a1 = (m + 1) * 30 - GAP_DEG / 2
            const mid = (a0 + a1) / 2
            const future = m > currentMonth
            const monthTotal = stats.byMonth[m]
            const [lx, ly] = polar(R1 + 13, mid)
            return (
              <g key={m}>
                <path className="gdv-ring-track" d={sectorPath(R0, R1, a0, a1)} fill="none" stroke="var(--hair)" strokeWidth={1} />
                {!future && monthTotal > 0 && (
                  <path
                    d={sectorPath(R0, R0 + (monthTotal / monthMax) * (R1 - R0), a0, a1)}
                    fill={heat(0.35 + 0.6 * (monthTotal / monthMax))}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onMonthClick(year, m)}
                  >
                    <title>{MONTH_NAMES[m]} · {fmtGoalNum(monthTotal)}{goal.unit ? ` ${goal.unit}` : ''}</title>
                  </path>
                )}
                <text x={lx} y={ly + 3} textAnchor="middle" fontSize={10} fontWeight={800} fill={future ? 'var(--ink-3)' : 'var(--ink-2)'}>{MONTH_NAMES[m]}</text>
              </g>
            )
          })}
          <circle cx={CX} cy={CY} r={R0 - 4} fill="var(--panel)" />
          <text x={CX} y={CY - 4} textAnchor="middle" fontSize={30} fontWeight={600} fill="var(--ink)" className="wf-serif" style={{ fontFamily: 'var(--serif)' }}>{fmtGoalNum(total)}</text>
          <text x={CX} y={CY + 15} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink-3)">of {fmtGoalNum(target)}{goal.unit ? ` ${goal.unit}` : ''}</text>
        </svg>
        <div className="gdv-ring-list">
          {Array.from({ length: currentMonth + 1 }, (_, m) => (
            <div key={m} className="gdv-ring-row-item">
              <span className="tiny gdv-ring-mo">{MONTH_NAMES[m]}</span>
              <div className="gdv-ring-bar"><div style={{ width: `${(stats.byMonth[m] / monthMax) * 100}%`, background: heat(0.4 + 0.55 * (stats.byMonth[m] / monthMax)) }} /></div>
              <span className="wf-serif gdv-ring-val">{fmtGoalNum(stats.byMonth[m])}</span>
            </div>
          ))}
          <div className="tiny muted" style={{ marginTop: 2 }}>{fmtGoalNum(Math.max(0, target - total))}{goal.unit ? ` ${goal.unit}` : ''} to go</div>
        </div>
      </div>
    </div>
  )
}
