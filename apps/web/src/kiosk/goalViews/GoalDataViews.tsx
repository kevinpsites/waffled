// The goal-detail data-view switcher: fetches the goal's day-bucketed activity,
// derives stats once (memoized), offers only the views that fit this goal's type +
// timeframe, and persists the last-selected view per goal. Sits in the goal-detail's
// left column in place of the old flat "By person" card.
import { useEffect, useMemo, useState } from 'react'
import { useGoalActivity, type GoalDetail as GoalDetailT } from '../../lib/api'
import { availableViews, classifyTimeframe, computeGoalStats, defaultView, type ViewKey } from '../../lib/goalStats'
import { getSavedView, saveView } from './persist'
import { DayDetailPopover } from './DayDetailPopover'
import { MonthDetailPopover } from './MonthDetailPopover'
import { WeekHeatmap } from './WeekHeatmap'
import { MonthHeatmap } from './MonthHeatmap'
import { PaceChart } from './PaceChart'
import { YearGrid } from './YearGrid'
import { ByPersonBars } from './ByPersonBars'
import { YearRing } from './YearRing'
import { CollectionGrid } from './CollectionGrid'
import { ConsistencyCalendar } from './ConsistencyCalendar'
import type { DataViewProps } from './types'

const VIEW_LABEL: Record<ViewKey, string> = {
  week: 'Week',
  month: 'Month',
  pace: 'Pace',
  year: 'Year',
  byPerson: 'By person',
  yearRing: 'Year ring',
  collection: 'Collection',
  consistency: 'Consistency',
}

const VIEW_COMPONENT: Record<ViewKey, (props: DataViewProps) => React.JSX.Element> = {
  week: WeekHeatmap,
  month: MonthHeatmap,
  pace: PaceChart,
  year: YearGrid,
  byPerson: ByPersonBars,
  yearRing: YearRing,
  collection: CollectionGrid,
  consistency: ConsistencyCalendar,
}

export function GoalDataViews({ goal }: { goal: GoalDetailT }) {
  const { activity, loading, error } = useGoalActivity(goal.id)
  const [view, setView] = useState<ViewKey | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<{ year: number; month: number } | null>(null)

  const timeframe = activity ? classifyTimeframe(activity.startDate, activity.endDate) : null
  const offered = useMemo(() => (timeframe ? availableViews(goal.goalType, timeframe) : []), [goal.goalType, timeframe])

  useEffect(() => {
    if (!timeframe || offered.length === 0) return
    const saved = getSavedView(goal.id)
    setView(saved && offered.includes(saved) ? saved : defaultView(goal.goalType, timeframe))
    // Only re-derive the initial view when the goal identity or its offer list changes —
    // NOT on every `view` state update, or a user's tap would immediately be overwritten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id, goal.goalType, timeframe, offered.join('|')])

  const stats = useMemo(() => {
    if (!activity) return null
    return computeGoalStats({ today: activity.today, startDate: activity.startDate, endDate: activity.endDate, target: goal.target, days: activity.days })
  }, [activity, goal.target])

  const personMap = useMemo(() => new Map(goal.participants.map((p) => [p.personId, p])), [goal.participants])

  // loading/error must be checked BEFORE "offered is empty": offered derives from
  // timeframe, which is null until activity resolves, so it's [] during loading
  // and on error too — checking it first made both of those branches dead code
  // and rendered a blank card instead of a loading state or an error message.
  if (loading) return <div className="card detail-card gdv-loading tiny muted">Loading…</div>
  if (error) return <div className="card detail-card tiny muted" style={{ padding: 20 }}>Couldn't load this goal's activity — try reloading.</div>
  if (offered.length === 0) return null // checklist: the existing steps card covers it
  if (!stats || !view) return <div className="card detail-card gdv-loading tiny muted">Loading…</div>

  function selectView(v: ViewKey) {
    setView(v)
    saveView(goal.id, v)
  }

  const ViewComponent = VIEW_COMPONENT[view]
  const segControl = (
    <div className="seg gdv-seg">
      {offered.map((v) => (
        <button key={v} type="button" className={v === view ? 'on' : ''} onClick={() => selectView(v)}>{VIEW_LABEL[v]}</button>
      ))}
    </div>
  )

  return (
    <div className="card detail-card">
      <ViewComponent
        goal={goal}
        stats={stats}
        personMap={personMap}
        onDayClick={setSelectedDay}
        onMonthClick={(year, month) => setSelectedMonth({ year, month })}
        headerRight={segControl}
      />
      {selectedDay && (
        <DayDetailPopover
          dateKey={selectedDay}
          dayEntry={stats.dayEntry(selectedDay)}
          goal={goal}
          personMap={personMap}
          onClose={() => setSelectedDay(null)}
        />
      )}
      {selectedMonth && (
        <MonthDetailPopover
          year={selectedMonth.year}
          month={selectedMonth.month}
          goal={goal}
          stats={stats}
          personMap={personMap}
          onClose={() => setSelectedMonth(null)}
        />
      )}
    </div>
  )
}
