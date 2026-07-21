// Lists domain — shared types (rows + inputs).
import type { QueryResultRow } from 'pg'

export interface ListRow extends QueryResultRow {
  id: string
  name: string
  emoji: string | null
  list_type: string
  is_auto_built: boolean
  sort_mode: string
  source_template_id?: string | null
}

export interface ListItemRow extends QueryResultRow {
  id: string
  name: string
  quantity: string | null
  checked: boolean
  checked_at: Date | null
  category: string | null
  priority: number
  sort_order: number | null
  assigned_to: string | null
  assignee_name?: string | null
  assignee_avatar?: string | null
  assignee_color?: string | null
  created_by: string | null
  source: string
  source_recipe_ids: string[] | null
  creator_name?: string | null
  creator_avatar?: string | null
  creator_color?: string | null
}

export interface CreateListInput {
  name: string
  emoji?: string | null
  sortOrder?: number
}

// Patch an item — check/uncheck, reassign, change quantity, or move section.
// Any subset of fields may be present.
export interface PatchItemInput {
  checked?: boolean
  assignedTo?: string | null
  quantity?: string | null
  category?: string | null
  priority?: number
  name?: string
}
