// Chores domain — shared types (rows, inputs, read-models).
import type { QueryResultRow } from 'pg'

export interface ChoreRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  person_id: string | null
  rrule: string | null
  reward_currency: string | null
  reward_amount: number
  due_time: string | null
  is_active: boolean
}

export interface CreateChoreInput {
  title: string
  personId?: string | null
  emoji?: string | null
  rewardAmount?: number
  rrule?: string | null
  dueTime?: string | null
  requiresApproval?: boolean
}

export interface PersonChoreSummary {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  total: number
  done: number
  stars: number
}

export interface TodayInstance {
  id: string
  choreId: string
  choreTitle: string
  emoji: string | null
  personId: string | null
  personName: string | null
  status: string
  rewardAmount: number | null
  rrule: string | null
  requiresApproval: boolean
  streak: number
}
