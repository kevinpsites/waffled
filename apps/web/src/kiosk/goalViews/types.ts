// Shared prop contract for every goal-detail data view (Week/Month/Pace/Year/
// By-person/Year-ring/Collection/Consistency). Every view gets the same bundle —
// components ignore whatever they don't need — so the switcher's dispatch stays trivial.
import type { ReactNode } from 'react'
import type { GoalDetail, GoalParticipant } from '../../lib/api'
import type { GoalStats } from '../../lib/goalStats'

export interface DataViewProps {
  goal: GoalDetail
  stats: GoalStats
  personMap: Map<string, GoalParticipant>
  onDayClick: (dateKey: string) => void
  // By-person and Year-ring are MONTH-scoped (a column/wedge is a whole month) —
  // they must not synthesize a fake "day 1" key and reuse the day-scoped popover,
  // which would silently show that one day's (usually empty) entries instead of
  // the month's. Those two views call this instead of onDayClick.
  onMonthClick: (year: number, month: number) => void
  // The segmented view-switcher control, rendered into this view's own header
  // (each view keeps its own title/subtitle — only the switcher is shared).
  headerRight?: ReactNode
}
