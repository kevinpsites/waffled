// AI recipe ingestion — photo → recipe and speech/text → recipe. Both paths ask
// the household's LLM for our canonical recipe *markdown*, then reuse the existing
// parseRecipe pipeline to produce the same structured draft the editor prefills
// from. The raw provider HTTP call isn't exercised here (external, like the capture
// adapters); we cover the deterministic seams: markdown → draft, vision-capability
// gating, the no-provider route behavior, and the source-photo TTL sweep.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { draftFromMarkdown, cleanupExpiredIngestPhotos, recordIngestPhotos } from '../src/modules/meals/recipe-ingest.service'
import { modelSupportsVision } from '../src/platform/llm'
import { getBlobStore, mediaKey } from '../src/platform/storage'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let queryFn: typeof import('../src/platform/db').query
let household = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

let kevin = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'waffled-ingest-'))
  process.env.STORAGE_DRIVER = 'local'
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  const db = await import('../src/platform/db')
  closePool = db.closePool
  queryFn = db.query
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
  household = (await queryFn<{ id: string }>(`select id from households limit 1`)).rows[0].id
  // Meals module is on by default? ensure it — enable via settings so routes aren't 403.
  await queryFn(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"meals":true}}'::jsonb where id = $1`, [household])
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

const SAMPLE_MD = `---
type: dinner
protein: chicken
cuisine: Italian
tags: [quick, family-favorite]
---

# Chicken Parmesan

*4 servings*

## Ingredients

### Chicken
- 2 chicken breasts, pounded thin
- 1 cup breadcrumbs

### Sauce
- 2 cups marinara

## Instructions

1. Bread the chicken in egg then breadcrumbs.
2. Pan-fry until golden.
   **Timer:** 4 minutes
3. Top with sauce and cheese, broil until bubbly.

## Notes

Kids like extra cheese.
Source: Grandma
`

describe('draftFromMarkdown — LLM markdown → structured editor draft', () => {
  it('parses title/meta/ingredients/steps the same shape parse-markdown returns', () => {
    const d = draftFromMarkdown(SAMPLE_MD)
    expect(d.recipe.title).toBe('Chicken Parmesan')
    expect(d.recipe.servings).toBe(4)
    expect(d.recipe.mealType).toBe('dinner')
    expect(d.recipe.cuisine).toBe('Italian')
    expect(d.recipe.tags).toContain('quick')
    // sections preserved on ingredients
    expect(d.ingredients.find((i) => i.name.includes('chicken breasts'))?.section).toBe('Chicken')
    expect(d.ingredients.some((i) => i.name.includes('marinara'))).toBe(true)
    // step timer parsed to seconds and stripped from text
    const timed = d.steps.find((s) => /pan-fry/i.test(s.instruction))
    expect(timed?.timerSeconds).toBe(240)
    expect(timed?.instruction).not.toMatch(/timer/i)
    // raw markdown returned for provenance
    expect(d.markdown).toContain('# Chicken Parmesan')
  })
})

describe('modelSupportsVision — per-model capability (pure cases)', () => {
  it('assumes vision for current Anthropic + OpenAI defaults', () => {
    expect(modelSupportsVision('anthropic', 'claude-haiku-4-5-20251001')).toBe(true)
    expect(modelSupportsVision('openai', 'gpt-4o-mini')).toBe(true)
  })
  it('has no vision on the on-device heuristic', () => {
    expect(modelSupportsVision('heuristic', null)).toBe(false)
  })
  it('returns null (unknown → must probe) for an arbitrary ollama model', () => {
    expect(modelSupportsVision('ollama', 'llama3.1')).toBeNull()
  })
})

describe('ingest routes — gating with no provider configured', () => {
  it('GET /api/recipes/ingest/config reports neither text nor vision on heuristic', async () => {
    const res = await call('GET', '/api/recipes/ingest/config', kevin)
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.text).toBe(false)
    expect(d.vision).toBe(false)
  })

  it('POST /api/recipes/ingest/voice 400s on empty text', async () => {
    const res = await call('POST', '/api/recipes/ingest/voice', kevin, { text: '   ' })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/recipes/ingest/voice 501s when no AI provider is selected', async () => {
    const res = await call('POST', '/api/recipes/ingest/voice', kevin, { text: 'chicken parm, bread the chicken, fry it, add sauce' })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.body).error).toBe('AIUnavailable')
  })

  it('POST /api/recipes/ingest/photo 400s on no images', async () => {
    const res = await call('POST', '/api/recipes/ingest/photo', kevin, { images: [] })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/recipes/ingest/photo 501s when the provider cannot do vision', async () => {
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    const res = await call('POST', '/api/recipes/ingest/photo', kevin, { images: [{ data: tinyJpeg, contentType: 'image/jpeg' }] })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.body).error).toBe('AIUnavailable')
  })
})

describe('cleanupExpiredIngestPhotos — source-photo TTL sweep', () => {
  it('deletes blobs + rows older than the retention window, keeps fresh ones', async () => {
    const store = getBlobStore()
    const oldKey = mediaKey(household, 'image/jpeg')
    const freshKey = mediaKey(household, 'image/jpeg')
    await store.put(oldKey, Buffer.from('old'), 'image/jpeg')
    await store.put(freshKey, Buffer.from('fresh'), 'image/jpeg')
    await recordIngestPhotos(household, [
      { storageKey: oldKey, contentType: 'image/jpeg' },
      { storageKey: freshKey, contentType: 'image/jpeg' },
    ])
    // Age the first row past the 1-day default window.
    await queryFn(`update recipe_ingest_photos set created_at = now() - interval '2 days' where storage_key = $1`, [oldKey])

    const result = await cleanupExpiredIngestPhotos()
    expect(result.deletedBlobs).toBeGreaterThanOrEqual(1)

    const remaining = await queryFn<{ storage_key: string }>(`select storage_key from recipe_ingest_photos where household_id = $1`, [household])
    const keys = remaining.rows.map((r) => r.storage_key)
    expect(keys).toContain(freshKey)
    expect(keys).not.toContain(oldKey)
    expect(existsSync(join(process.env.MEDIA_DIR!, oldKey))).toBe(false)
    expect(existsSync(join(process.env.MEDIA_DIR!, freshKey))).toBe(true)
  })
})
