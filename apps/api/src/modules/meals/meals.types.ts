// Meals & recipes — shared types (rows, inputs, read-models).
import type { QueryResultRow } from 'pg'

export interface RecipeRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  description: string | null
  category: string | null
  tags: string[] | null
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  servings: number
  image_url: string | null
  source_name: string | null
  is_favorite: boolean
  cooked_count: number
}

export interface CreateRecipeInput {
  title: string
  emoji?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  servings?: number
  imageUrl?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
}

export interface RecipeIngredientRow extends QueryResultRow {
  id: string
  name: string
  amount: string | null
  unit: string | null
  prep_note: string | null
  display: string | null
  section: string | null
  sort_order: number | null
}

export interface IngredientInput {
  name: string
  amount?: number | null
  unit?: string | null
  prepNote?: string | null
  display?: string | null
  section?: string | null
  sortOrder?: number | null
}

export interface RecipeOverrides {
  meta?: Partial<Record<'mealType' | 'protein' | 'base' | 'cuisine' | 'effort' | 'cookMethod' | 'flavorProfile', string>>
  dietary?: string[]
  addedTags?: string[]
  removedTags?: string[]
  subs?: Record<string, string>
  stepNotes?: Record<string, string>
}

export interface PlanCard {
  date: string
  mealType: string
  title: string
  recipeId: string | null
  emoji: string | null
  minutes: number | null
  servings: number
  note: string | null
}

export interface PlanWeekInput {
  start: string
  mealType?: string
  dates?: string[] // specific days to fill; default = empty `mealType` slots this week
  cookingFor?: number | null
  keepInMind?: string | null
  useUp?: string[]
  avoidTitles?: string[] // steer away from these (variety / reshuffle / swap)
}
