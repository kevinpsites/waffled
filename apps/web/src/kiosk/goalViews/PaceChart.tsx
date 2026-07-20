// Pace — cumulative logged amount vs. the straight-line path to target. Handles
// three timeframes generically (fixed short/long, or open-ended) — never a
// hard-coded 365; everything derives from the goal's own start/end.
import { fmtGoalNum } from '../../lib/api'
import { addDaysKey, diffDaysKey, parseLocalDateKey } from '../../lib/goalStats'
import type { DataViewProps } from './types'

const W = 560
const H = 248
const PAD_L = 42
const PAD_R = 14
const PAD_T = 14
const PAD_B = 26

function fmtMonthDay(dateKey: string): string {
  return parseLocalDateKey(dateKey).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function PaceChart({ goal, stats, onDayClick, headerRight }: DataViewProps) {
  const { startDate, today, pace, projectedFinish } = stats
  const target = goal.target ?? 0
  // Fixed goals chart the goal's own window; open-ended goals chart start..the
  // later of today/the projected finish (so the projection line has room to land).
  const domainEnd = stats.endDate ?? (projectedFinish && projectedFinish > today ? projectedFinish : addDaysKey(today, 14))
  const totalSpan = Math.max(1, diffDaysKey(domainEnd, startDate))
  const pw = W - PAD_L - PAD_R
  const ph = H - PAD_T - PAD_B
  const x = (dateKey: string) => PAD_L + (diffDaysKey(dateKey, startDate) / totalSpan) * pw
  const y = (v: number) => PAD_T + (1 - clamp01(target ? v / target : 0)) * ph

  // Walking every calendar day (potentially years' worth) to emit one SVG vertex
  // apiece is wasted work: between logged days `cum` never changes, so those
  // interior points are collinear and contribute nothing to the visible line.
  // `stats.byDay` only holds days that actually have a log (sparse), so instead
  // we walk just those, emitting a flat point just before each jump (holding the
  // previous value right up to the day before) and the jump point itself — the
  // same rendered staircase shape, without visiting every no-op day in between.
  let cum = 0
  const points: Array<[number, number]> = [[x(startDate), y(0)]]
  const activeDates = [...stats.byDay.keys()].filter((d) => d >= startDate && d <= today).sort()
  for (const d of activeDates) {
    const dayBefore = addDaysKey(d, -1)
    if (dayBefore >= startDate) points.push([x(dayBefore), y(cum)])
    cum += stats.dayEntry(d).total
    points.push([x(d), y(cum)])
  }
  points.push([x(today), y(cum)])
  const total = cum
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const areaPath = points.length
    ? `M${PAD_L},${y(0).toFixed(1)} ${points.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} L${points[points.length - 1][0].toFixed(1)},${y(0).toFixed(1)} Z`
    : ''
  const todayXY = points[points.length - 1] ?? [x(today), y(0)]

  const gridVals = [0, target / 4, target / 2, (3 * target) / 4, target]

  return (
    <div>
      <div className="gdv-head">
        <div>
          <div className="gdv-head-t">Path to {fmtGoalNum(target)}</div>
          <div className="gdv-head-sub">cumulative {goal.unit || ''} vs. the pace you need</div>
        </div>
        <div className="gdv-head-grow gdv-head-grow-row">
          {pace && (
            <span className="gdv-pace-pill" style={{ color: pace.delta >= 0 ? 'var(--success)' : 'var(--danger)', background: pace.delta >= 0 ? 'var(--success-t)' : 'var(--danger-t)' }}>
              {pace.delta >= 0 ? '+' : ''}{fmtGoalNum(pace.delta)} {goal.unit || ''} vs pace
            </span>
          )}
          {headerRight}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Pace chart">
        <defs>
          <linearGradient id={`pg-${goal.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#25A368" stopOpacity=".28" />
            <stop offset="1" stopColor="#25A368" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} stroke="var(--hair)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(v) + 3} textAnchor="end" fontSize={9.5} fontWeight={700} fill="var(--ink-3)">{fmtGoalNum(v)}</text>
          </g>
        ))}
        {pace && <line x1={x(startDate)} y1={y(0)} x2={x(domainEnd)} y2={y(target)} stroke="var(--ink-3)" strokeWidth={2} strokeDasharray="5 5" />}
        {!pace && target > 0 && <line x1={PAD_L} y1={y(target)} x2={W - PAD_R} y2={y(target)} stroke="var(--ink-3)" strokeWidth={2} strokeDasharray="5 5" />}
        {areaPath && <path d={areaPath} fill={`url(#pg-${goal.id})`} />}
        {linePath && <path d={linePath} fill="none" stroke="#1c9160" strokeWidth={3} strokeLinejoin="round" />}
        {!pace && projectedFinish && target > 0 && (
          <line x1={todayXY[0]} y1={todayXY[1]} x2={x(projectedFinish)} y2={y(target)} stroke="#1c9160" strokeWidth={2} strokeDasharray="4 4" opacity={0.55} />
        )}
        <line x1={todayXY[0]} y1={PAD_T} x2={todayXY[0]} y2={H - PAD_B} stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.6} />
        <circle
          cx={todayXY[0]}
          cy={todayXY[1]}
          r={6}
          fill="#1c9160"
          stroke="#fff"
          strokeWidth={2.5}
          style={{ cursor: 'pointer' }}
          onClick={() => onDayClick(today)}
        />
        <text x={todayXY[0] - 8} y={todayXY[1] - 12} textAnchor="end" fontSize={13} fontWeight={800} fill="#1c7a4e">
          {fmtGoalNum(total)} {goal.unit || ''}
        </text>
      </svg>
      <div className="gdv-footer gdv-pace-legend">
        <span className="legdot"><i style={{ background: '#1c9160' }} />Logged so far</span>
        {pace ? (
          <span className="legdot"><i style={{ background: 'var(--ink-3)' }} />Pace to hit {fmtGoalNum(target)} by {fmtMonthDay(stats.endDate as string)}</span>
        ) : (
          <span className="legdot"><i style={{ background: 'var(--ink-3)' }} />Target · {fmtGoalNum(target)}{goal.unit ? ` ${goal.unit}` : ''}</span>
        )}
        <span className="tiny muted gdv-footer-right">
          {pace ? (
            projectedFinish && <>Projected finish · <b className="wf-serif" style={{ color: 'var(--success)' }}>{fmtMonthDay(projectedFinish)}</b></>
          ) : projectedFinish ? (
            <>On track to finish ~ <b className="wf-serif" style={{ color: 'var(--success)' }}>{fmtMonthDay(projectedFinish)}</b></>
          ) : (
            <>Keep going — {fmtGoalNum(Math.max(0, target - total))}{goal.unit ? ` ${goal.unit}` : ''} to go</>
          )}
        </span>
      </div>
    </div>
  )
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
