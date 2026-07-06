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
  storage_key: string | null
  content_type: string | null
  source_name: string | null
  is_favorite: boolean
  cooked_count: number
}

// Rich frontmatter-style metadata, editable in-app (mirrors the markdown source
// columns). Shared by create + update.
export interface RecipeMetaInput {
  mealType?: string | null
  protein?: string | null
  base?: string | null
  cuisine?: string | null
  effort?: string | null
  cookMethod?: string | null
  flavorProfile?: string | null
  dietary?: string[] | null
  vegetables?: string[] | null
  collection?: string | null
}

export interface StepInput {
  instruction: string
  ingredients?: string[]
  timerSeconds?: number | null
}

export interface CreateRecipeInput extends RecipeMetaInput {
  title: string
  emoji?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  servings?: number
  imageUrl?: string | null
  storageKey?: string | null
  contentType?: string | null
  sourceName?: string | null
  sourceUrl?: string | null
  notes?: string | null
  ingredients?: IngredientInput[]
  steps?: StepInput[]
}

// In-app edit of an existing recipe. Scalar/metadata fields are partial; passing
// `ingredients` or `steps` does a full replace and detaches an imported recipe from
// its markdown source (so a future re-import skips it). `overrides`/userNotes/etc.
// keep the legacy non-destructive paths working.
export interface UpdateRecipeInput extends RecipeMetaInput {
  isFavorite?: boolean
  title?: string
  rating?: number
  userNotes?: string
  overrides?: RecipeOverrides
  emoji?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  prepTimeMinutes?: number | null
  cookTimeMinutes?: number | null
  servings?: number
  imageUrl?: string | null
  storageKey?: string | null
  contentType?: string | null
  sourceName?: string | null
  notes?: string | null
  ingredients?: IngredientInput[]
  steps?: StepInput[]
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
  wantToTry?: string[] // specific new dishes the family wants to try — featured as recipeId:null suggestions
  trySomethingNew?: boolean // nudge the plan toward novelty: include ≥1 brand-new dish even if the library could fill it
}

// Month planner (dinners). The LLM drafts a rotation POOL of dishes; the server
// then lays that pool across the month's chosen nights honoring the guardrails.
export interface PlanMonthInput {
  start: string // any date in the target month
  weekdays?: number[] // 0(Sun)–6 to plan; default Mon–Fri
  skipDates?: string[] // dates to leave unplanned (travel / eating out)
  cookingFor?: number | null
  keepInMind?: string | null
  useUp?: string[]
  allowRepeats?: boolean // reuse dishes across the month (a rotation)
  repeatGapDays?: number // min days between the same dish when repeating (default 7)
  weekdayThemes?: Record<string, string> // dow "0".."6" -> theme key (see MONTH_THEMES)
  weeknightMaxMin?: number | null // cap weeknight cook time (quick weeknights)
  leftovers?: boolean // schedule a leftover night after an involved cook
  avoidTitles?: string[] // reshuffle/swap support
  dates?: string[] // explicit nights to (re)draft; overrides weekdays/skip when set
}
