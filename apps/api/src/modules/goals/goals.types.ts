// Goals domain — shared input types.

export interface CreateGoalListInput {
  name: string
  emoji?: string | null
  colorHex?: string | null
  isPrivate?: boolean
  memberIds?: string[]
}

export interface UpdateGoalListInput {
  name?: string
  emoji?: string | null
  colorHex?: string | null
  isPrivate?: boolean
  memberIds?: string[]
}

export interface CreateGoalInput {
  title: string
  goalListId?: string | null
  emoji?: string | null
  category?: string | null
  goalType: string
  unit?: string | null
  targetValue?: number | null
  habitPeriod?: string | null
  habitTargetPerPeriod?: number | null
  trackingMode: string
  logMethod?: string | null
  autoFromCalendar?: boolean
  deadline?: string | null
  isFeatured?: boolean
  hasRewards?: boolean
  participantIds?: string[]
  milestones?: Array<{ threshold: number; emoji?: string | null; label?: string | null; rewardText?: string | null }>
  steps?: Array<{ id?: string; label: string }>
}

export interface UpdateGoalInput {
  participantIds?: string[]
  milestones?: Array<{ threshold: number; emoji?: string | null; label?: string | null; rewardText?: string | null }>
  steps?: Array<{ id?: string; label: string }>
  [key: string]: unknown
}
