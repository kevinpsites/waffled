#!/usr/bin/env node
// Mass-import Markdown recipes into a running Waffled server over the public API.
//
// Unlike import-recipes.ts (which talks straight to the DB from the host), this uses
// only the HTTP API + an API key, so you can point it at any Waffled instance —
// including a remote self-hosted server — from any machine with Node 18+.
//
// For each *.md file it calls two v0.2.0 endpoints:
//   POST /api/recipes/parse-markdown   → parse the Markdown into structured fields
//   POST /api/recipes                  → create the recipe
//
// Setup
//   1. In the app: Settings → 🔑 API Keys (admin) → New key, tick the **Meals** scope
//      (meals:write). Copy the `waffled_…` secret (shown once).
//   2. Run:
//        WAFFLED_URL=https://your.host \
//        WAFFLED_API_KEY=waffled_xxx \
//        node apps/api/scripts/import-recipes-api.mjs ./my-recipes
//
// Flags
//   --recursive     also descend into subfolders
//   --dry-run       parse + report, but don't create anything
//   --force         create even if a recipe with the same title already exists
//   --concurrency N parallel uploads (default 4)
//
// Exit code is non-zero if any file failed (so it's CI/script friendly).

import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const dir = positional[0]

const BASE = (process.env.WAFFLED_URL || 'http://localhost:8080').replace(/\/+$/, '')
const KEY = process.env.WAFFLED_API_KEY || ''
const RECURSIVE = flags.has('--recursive')
const DRY = flags.has('--dry-run')
const FORCE = flags.has('--force')
const CONCURRENCY = Math.max(1, Number((args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 4)

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(2)
}

if (!dir) die('Usage: node import-recipes-api.mjs <dir> [--recursive] [--dry-run] [--force]')
if (!KEY) die('Set WAFFLED_API_KEY to a key with the meals:write scope (Settings → API Keys).')

const HEADERS = { 'content-type': 'application/json', 'x-api-key': KEY }

async function api(path, init) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, init)
  } catch (e) {
    throw new Error(`network error reaching ${BASE} — is the server up and the URL right? (${e.message})`)
  }
  if (res.status === 401) die('401 Unauthorized — the API key is wrong or was revoked.')
  if (res.status === 403) die("403 Forbidden — the key is missing the 'meals:write' scope (Settings → API Keys → edit the key).")
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!res.ok) throw new Error(`${res.status} ${body?.message || body?.error || text || res.statusText}`)
  return body
}

// Collect *.md files (skip README), optionally recursing.
async function collect(root) {
  const out = []
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { if (RECURSIVE) await walk(p) }
      else if (ent.name.toLowerCase().endsWith('.md') && ent.name.toLowerCase() !== 'readme.md') out.push(p)
    }
  }
  await walk(root)
  return out.sort()
}

async function importOne(file, existing) {
  const md = await readFile(file, 'utf8')
  if (!md.trim()) return { file, status: 'skip', reason: 'empty file' }

  const parsed = await api('/api/recipes/parse-markdown', { method: 'POST', headers: HEADERS, body: JSON.stringify({ markdown: md }) })
  const recipe = parsed?.recipe || {}
  const title = (recipe.title || '').trim()
  if (!title) return { file, status: 'fail', reason: 'no title parsed (needs a "# Title" heading or frontmatter title)' }

  if (!FORCE && existing.has(title.toLowerCase())) return { file, status: 'skip', reason: `already exists: "${title}"`, title }
  if (DRY) return { file, status: 'dry', title, ingredients: (parsed.ingredients || []).length, steps: (parsed.steps || []).length }

  const created = await api('/api/recipes', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ ...recipe, ingredients: parsed.ingredients || [], steps: parsed.steps || [] }),
  })
  existing.add(title.toLowerCase())
  return { file, status: 'ok', title: created?.recipe?.title || title }
}

// Simple concurrency pool that preserves per-item results.
async function pool(items, n, fn) {
  const results = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      try { results[idx] = await fn(items[idx], idx) }
      catch (e) { results[idx] = { file: items[idx], status: 'fail', reason: e.message } }
    }
  }))
  return results
}

const files = await collect(dir)
if (!files.length) die(`No .md files found in ${dir}${RECURSIVE ? ' (recursive)' : ''}.`)

// Pre-fetch existing titles so re-runs are idempotent (skip dupes) unless --force.
const existing = new Set()
if (!FORCE) {
  const list = await api('/api/recipes', { headers: { 'x-api-key': KEY } })
  for (const r of list?.recipes || []) if (r?.title) existing.add(String(r.title).toLowerCase())
}

console.log(`\n${DRY ? '[dry-run] ' : ''}Importing ${files.length} file(s) → ${BASE}  (concurrency ${CONCURRENCY})\n`)

const results = await pool(files, CONCURRENCY, (f) => importOne(f, existing))

let ok = 0, skip = 0, fail = 0, dry = 0
for (const r of results) {
  const name = basename(r.file)
  if (r.status === 'ok') { ok++; console.log(`  ✓ ${name} → "${r.title}"`) }
  else if (r.status === 'dry') { dry++; console.log(`  • ${name} → "${r.title}" (${r.ingredients} ing, ${r.steps} steps)`) }
  else if (r.status === 'skip') { skip++; console.log(`  – ${name} — ${r.reason}`) }
  else { fail++; console.log(`  ✗ ${name} — ${r.reason}`) }
}

console.log(`\nDone: ${ok} created, ${dry} previewed, ${skip} skipped, ${fail} failed.\n`)
process.exit(fail > 0 ? 1 : 0)
