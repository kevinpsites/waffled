// AI recipe ingestion. Two entry points — a photo (or photos) of a physical/printed
// recipe, and a free-form spoken/typed description — both ask the household's LLM for
// our canonical recipe *markdown*, then reuse parseRecipe() to produce the exact same
// structured draft the editor prefills from (see parse-markdown). The model output is
// human-reviewable markdown; nothing is saved until the user confirms in the editor.
//
// Photo source images are throwaway: we persist them so the user can retry extraction,
// but a background sweep (cleanupExpiredIngestPhotos) deletes them after a short
// retention window. The recipe's own hero image is a separate, kept thing.
import { query } from '../../platform/db'
import { getBlobStore, mediaKey } from '../../platform/storage'
import { log } from '../../platform/logger'
import { runJob, registerJob } from '../../platform/jobs'
import { completeJson, visionAvailable, type LlmImage } from '../../platform/llm'
import { parseRecipe } from './recipe-markdown'

// ── Shared draft shape (mirrors POST /api/recipes/parse-markdown) ────────────
export interface RecipeDraft {
  recipe: {
    title: string
    emoji: string
    servings: number
    tags: string[]
    notes: string | null
    sourceName: string | null
    mealType: string | null
    protein: string | null
    base: string | null
    cuisine: string | null
    effort: string | null
    cookMethod: string | null
    flavorProfile: string | null
    dietary: string[]
    vegetables: string[]
  }
  ingredients: Array<{ name: string; amount: number | null; unit: string | null; prepNote: string | null; section: string | null }>
  steps: Array<{ instruction: string; ingredients: string[]; timerSeconds: number | null }>
  markdown: string
}

// Turn our canonical recipe markdown into the structured editor draft. Pure and
// deterministic — the whole ingredient/timer/section/aisle logic is reused from the
// existing markdown parser, so photo/voice imports behave exactly like a paste.
export function draftFromMarkdown(markdown: string): RecipeDraft {
  const r = parseRecipe(markdown)
  return {
    recipe: {
      title: r.title,
      emoji: r.emoji,
      servings: r.servings,
      tags: r.tags,
      notes: r.notes,
      sourceName: r.sourceName,
      mealType: r.mealType,
      protein: r.protein,
      base: r.base,
      cuisine: r.cuisine,
      effort: r.effort,
      cookMethod: r.cookMethod,
      flavorProfile: r.flavorProfile,
      dietary: r.dietary,
      vegetables: r.vegetables,
    },
    ingredients: r.ingredients.map((it) => ({
      name: it.name || it.display,
      amount: it.amount,
      unit: it.unit,
      prepNote: it.prepNote,
      section: it.section,
    })),
    steps: r.steps.map((s) => ({ instruction: s.text, ingredients: s.ingredients, timerSeconds: s.timerSeconds ?? null })),
    markdown,
  }
}

// ── LLM prompt (both paths ask for our markdown) ─────────────────────────────
const INGEST_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string', description: 'The full recipe in the required markdown format.' },
  },
  required: ['markdown'],
} as const

const FORMAT_SPEC = `Output the recipe as a single Markdown document in EXACTLY this structure:

---
type: <breakfast|lunch|dinner|snack|dessert>
protein: <main protein, e.g. chicken|beef|pork|fish|shrimp|tofu|beans|egg>
base: <main starch/base, e.g. rice|noodle|pasta|bread|potato|tortilla>
cuisine: <e.g. Italian|Mexican|Thai|American>
effort: <weeknight|weekend>
cook_method: <stovetop|oven|grill|slow-cooker|sheet-pan|no-cook>
flavor_profile: <e.g. savory|spicy|sweet|fresh|hearty>
dietary: [<gluten-free, vegetarian, vegan, dairy-free, …>]
vegetables: [<spinach, tomato, …>]
tags: [<short tags, e.g. quick, family-favorite>]
---

# <Recipe Title>

*<N> servings*

## Ingredients

### <Optional Section, e.g. Sauce>
- <amount> <unit> <ingredient>, <optional prep note>

## Instructions

1. <step text>
   **Ingredients:**
   - <ingredient this step uses, matching the ones listed above>
   **Timer:** <duration, e.g. 4 minutes>
2. <next step>

## Notes

<any notes>
Source: <where it came from, if known>

Filling it out well (this matters — a bare title + ingredients + steps is NOT enough):
- FRONTMATTER: fill in as many keys as you reasonably can by *classifying the dish* — cuisine,
  protein, base, cook_method, effort, flavor_profile, meal type and a couple of tags can almost
  always be deduced from the ingredients and method (e.g. a garlic-butter shrimp pasta →
  type: dinner, protein: shrimp, base: pasta, cuisine: Italian, cook_method: stovetop). This is
  reasoning about what you were given, NOT making things up — do it. Omit a key only when it
  genuinely doesn't apply. Also add \`dietary\` tags when clearly true (vegetarian, gluten-free…).
- PER-STEP INGREDIENTS: under each step, add a \`**Ingredients:**\` sub-list naming the
  ingredients that step uses (copied from the Ingredients list above), so the cook sees what to
  grab at each step. Omit the sub-list only for a step that uses no ingredients (e.g. "Preheat
  the oven").
- TIMERS: add a \`**Timer:**\` line whenever a step involves a cook/bake/simmer/rest/chill time —
  use the stated duration, or a sensible one when the step clearly implies waiting (e.g.
  "simmer until thickened, about 15 minutes").

Hard rules (do NOT break these):
- Keep amounts and units exactly as given; use "to taste" (no number) when unquantified.
- Do NOT invent ingredients or cooking steps that weren't in the source. Classifying metadata is
  fine and expected; fabricating ingredients/steps is not.
- Return ONLY the markdown, nothing else.`

const PHOTO_SYSTEM = `You transcribe photos of physical or printed recipes into structured Markdown.
Read every provided image (they may be multiple pages/photos of ONE recipe) and combine them into one recipe.
${FORMAT_SPEC}`

const VOICE_SYSTEM = `You turn a free-form spoken or typed description of a recipe into structured Markdown.
The description may be rambling, out of order, or incomplete — organize it into clear ingredients and numbered steps without inventing specifics that weren't said.
${FORMAT_SPEC}`

const AI_UNAVAILABLE_RE = /no ai provider|not configured|not selected/i

// Raised when the household has no vision-capable model — the route maps it to 501.
export class VisionUnavailableError extends Error {
  constructor() {
    super('No vision-capable AI provider selected — choose Claude, OpenAI, or a vision Ollama model in Settings → AI & capture')
    this.name = 'VisionUnavailableError'
  }
}

// Raised for a bad photo upload (unsupported type, too large, empty) — the route maps it
// to 400. It's a client input error, not a server ingest failure (502).
export class IngestInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestInputError'
  }
}

export function isAiUnavailable(err: unknown): boolean {
  return err instanceof VisionUnavailableError || (err instanceof Error && AI_UNAVAILABLE_RE.test(err.message))
}

// ── Speech / text → recipe ───────────────────────────────────────────────────
export async function ingestRecipeFromText(tenant: { householdId: string }, text: string): Promise<{ draft: RecipeDraft; via: string }> {
  const { data, via } = await completeJson(tenant.householdId, {
    system: VOICE_SYSTEM,
    user: text.trim(),
    schema: INGEST_SCHEMA,
    schemaName: 'recipe_markdown',
    maxTokens: 2000,
    timeoutMs: 60_000,
  })
  const markdown = String((data as { markdown?: unknown }).markdown ?? '').trim()
  if (!markdown) throw new Error('model returned empty recipe markdown')
  return { draft: draftFromMarkdown(markdown), via }
}

// ── Photos → recipe ──────────────────────────────────────────────────────────
export const MAX_INGEST_PHOTOS = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // matches POST /api/media
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface IngestPhotoInput {
  data: string // base64 (no data: prefix)
  contentType: string
}

// Persist recipe-ingest source photos so the sweep can find + delete them later.
export async function recordIngestPhotos(
  householdId: string,
  photos: Array<{ storageKey: string; contentType: string }>
): Promise<void> {
  if (!photos.length) return
  const values: string[] = []
  const params: unknown[] = [householdId]
  photos.forEach((p, i) => {
    values.push(`($1, $${i * 2 + 2}, $${i * 2 + 3})`)
    params.push(p.storageKey, p.contentType)
  })
  await query(
    `insert into recipe_ingest_photos (household_id, storage_key, content_type) values ${values.join(', ')}`,
    params
  )
}

export async function ingestRecipeFromPhotos(
  tenant: { householdId: string },
  photos: IngestPhotoInput[]
): Promise<{ draft: RecipeDraft; via: string; photoKeys: string[] }> {
  // Validate + decode every image up front. Bad input is a 400 (IngestInputError) and is
  // checked BEFORE the vision gate — it stores nothing, so "gate before store" still holds,
  // and a malformed upload is rejected the same way regardless of the household's provider.
  const decoded = photos.map((p) => {
    if (!ALLOWED_IMAGE_TYPES.has(p.contentType)) throw new IngestInputError(`unsupported image type: ${p.contentType}`)
    const bytes = Buffer.from(p.data, 'base64')
    if (bytes.length === 0) throw new IngestInputError('empty image')
    if (bytes.length > MAX_IMAGE_BYTES) throw new IngestInputError('image too large')
    return { bytes, contentType: p.contentType, dataBase64: p.data }
  })

  // Gate on vision BEFORE storing anything, so a heuristic/text-only household gets a
  // clean 501 instead of orphaned blobs.
  if (!(await visionAvailable(tenant.householdId))) throw new VisionUnavailableError()

  // Persist + record first (so retention works even if extraction later fails).
  const store = getBlobStore()
  const stored: Array<{ storageKey: string; contentType: string }> = []
  for (const d of decoded) {
    const key = mediaKey(tenant.householdId, d.contentType)
    await store.put(key, d.bytes, d.contentType)
    stored.push({ storageKey: key, contentType: d.contentType })
  }
  await recordIngestPhotos(tenant.householdId, stored)

  const images: LlmImage[] = decoded.map((d) => ({ contentType: d.contentType, dataBase64: d.dataBase64 }))
  const { data, via } = await completeJson(tenant.householdId, {
    system: PHOTO_SYSTEM,
    user: 'Transcribe this recipe into the required markdown format.',
    schema: INGEST_SCHEMA,
    schemaName: 'recipe_markdown',
    images,
    maxTokens: 2000,
    timeoutMs: 90_000,
  })
  const markdown = String((data as { markdown?: unknown }).markdown ?? '').trim()
  if (!markdown) throw new Error('model returned empty recipe markdown')
  return { draft: draftFromMarkdown(markdown), via, photoKeys: stored.map((s) => s.storageKey) }
}

// ── Source-photo TTL sweep (mirrors chore-proof-cleanup) ─────────────────────
export const DEFAULT_RECIPE_PHOTO_TTL_DAYS = 1

// One sweep across every household: hard-delete recipe-ingest photo rows (and their
// blobs) older than that household's retention window. Returns counts for logs/tests.
export async function cleanupExpiredIngestPhotos(): Promise<{ deletedBlobs: number; households: number }> {
  const { rows: households } = await query<{ id: string; ttl: number }>(
    `select id, coalesce((settings #>> '{meals,recipePhotoTtlDays}')::int, ${DEFAULT_RECIPE_PHOTO_TTL_DAYS}) as ttl
       from households where deleted_at is null`
  )
  const store = getBlobStore()
  let deletedBlobs = 0
  for (const h of households) {
    if (!Number.isFinite(h.ttl) || h.ttl <= 0) continue // 0/negative = keep indefinitely
    const { rows } = await query<{ storage_key: string }>(
      `with expired as (
         select id, storage_key from recipe_ingest_photos
          where household_id = $1 and created_at < now() - make_interval(days => $2::int)
          for update
       ), del as (
         delete from recipe_ingest_photos rip using expired e where rip.id = e.id
       )
       select storage_key from expired`,
      [h.id, h.ttl]
    )
    for (const r of rows) {
      try {
        await store.delete(r.storage_key)
        deletedBlobs++
      } catch (err) {
        console.error('recipe ingest photo sweep: blob delete failed', r.storage_key, err)
      }
    }
  }
  return { deletedBlobs, households: households.length }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null

// Periodic sweep (default once a day). Mirrors startProofCleanupScheduler.
// Container-only — Lambda never runs server.ts.
export function startRecipeIngestCleanupScheduler(): void {
  if (cleanupTimer) return
  const intervalMs = parseInt(process.env.RECIPE_PHOTO_CLEANUP_INTERVAL_MS ?? '3600000', 10) // hourly (TTL is ~1 day)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  registerJob('recipe-ingest-cleanup')
  cleanupTimer = setInterval(() => {
    runJob('recipe-ingest-cleanup', cleanupExpiredIngestPhotos).catch((err) => log.error('recipe ingest cleanup tick failed', { err }))
  }, intervalMs)
  cleanupTimer.unref?.()
  log.info('recipe ingest cleanup scheduler started', { intervalSec: Math.round(intervalMs / 1000) })
}
