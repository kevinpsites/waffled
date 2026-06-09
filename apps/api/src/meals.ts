// Meals & recipes. Recipes are shared household assets; meal-plan entries (added
// in the next chunk) schedule recipes onto days and power the kiosk meal card.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, type Tenant } from './households'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

export async function createRecipe(tenant: Tenant, input: CreateRecipeInput): Promise<RecipeRow> {
  const { rows } = await query<RecipeRow>(
    `insert into recipes
       (household_id, title, emoji, description, category, tags,
        prep_time_minutes, cook_time_minutes, servings, image_url, source_name, source_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9,4), $10,$11,$12)
     returning *`,
    [
      tenant.householdId,
      input.title,
      input.emoji ?? null,
      input.description ?? null,
      input.category ?? null,
      input.tags ?? null,
      input.prepTimeMinutes ?? null,
      input.cookTimeMinutes ?? null,
      input.servings ?? null,
      input.imageUrl ?? null,
      input.sourceName ?? null,
      input.sourceUrl ?? null,
    ]
  )
  return rows[0]
}

export async function listRecipes(householdId: string): Promise<RecipeRow[]> {
  const { rows } = await query<RecipeRow>(
    `select * from recipes where household_id = $1 and deleted_at is null order by title`,
    [householdId]
  )
  return rows
}

export async function getRecipe(householdId: string, id: string): Promise<RecipeRow | null> {
  const { rows } = await query<RecipeRow>(
    `select * from recipes where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export function presentRecipe(r: RecipeRow) {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    description: r.description,
    category: r.category,
    tags: r.tags,
    prepTimeMinutes: r.prep_time_minutes,
    cookTimeMinutes: r.cook_time_minutes,
    servings: r.servings,
    imageUrl: r.image_url,
    sourceName: r.source_name,
    isFavorite: r.is_favorite,
    cookedCount: r.cooked_count,
  }
}

export function registerMealRoutes(api: Api): void {
  api.post('/api/recipes', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateRecipeInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    const recipe = await createRecipe(tenant, { ...body, title: body.title.trim() } as CreateRecipeInput)
    return res.status(201).json({ recipe: presentRecipe(recipe) })
  })

  api.get('/api/recipes', async (req: Request) => {
    const tenant = await requireTenant(req)
    const recipes = await listRecipes(tenant.householdId)
    return { recipes: recipes.map(presentRecipe) }
  })

  api.get('/api/recipes/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const recipe = await getRecipe(tenant.householdId, id)
    if (!recipe) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return { recipe: presentRecipe(recipe) }
  })
}
