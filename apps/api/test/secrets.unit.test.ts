import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateSecrets } from '../src/platform/secrets'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'waffled-secrets-'))
})
afterEach(() => {
  chmodSync(dir, 0o755)
  rmSync(dir, { recursive: true, force: true })
})

describe('loadOrCreateSecrets', () => {
  it('creates secrets.json with both keys when absent', () => {
    const env: NodeJS.ProcessEnv = {}
    loadOrCreateSecrets(dir, env)
    const file = join(dir, 'secrets.json')
    expect(Buffer.from(env.TOKEN_ENCRYPTION_KEY!, 'base64').length).toBe(32)
    expect(env.LOCAL_JWT_SECRET!.length).toBeGreaterThanOrEqual(32)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8')).LOCAL_JWT_SECRET).toBe(env.LOCAL_JWT_SECRET)
  })

  it('reuses existing file', () => {
    const a: NodeJS.ProcessEnv = {}
    const b: NodeJS.ProcessEnv = {}
    loadOrCreateSecrets(dir, a)
    loadOrCreateSecrets(dir, b)
    expect(b.LOCAL_JWT_SECRET).toBe(a.LOCAL_JWT_SECRET)
    expect(b.TOKEN_ENCRYPTION_KEY).toBe(a.TOKEN_ENCRYPTION_KEY)
  })

  it('env wins over file', () => {
    loadOrCreateSecrets(dir, {})
    const preset = 'x'.repeat(40)
    const env: NodeJS.ProcessEnv = { LOCAL_JWT_SECRET: preset }
    loadOrCreateSecrets(dir, env)
    expect(env.LOCAL_JWT_SECRET).toBe(preset)
  })

  it('persists env-supplied keys so dropping them from .env later keeps the same key', () => {
    const preset = 'x'.repeat(40)
    const key = Buffer.alloc(32, 7).toString('base64')
    loadOrCreateSecrets(dir, { LOCAL_JWT_SECRET: preset, TOKEN_ENCRYPTION_KEY: key })
    const later: NodeJS.ProcessEnv = {}
    loadOrCreateSecrets(dir, later)
    expect(later.LOCAL_JWT_SECRET).toBe(preset)
    expect(later.TOKEN_ENCRYPTION_KEY).toBe(key)
  })

  it('non-string values are treated as corrupt and not overwritten', () => {
    const file = join(dir, 'secrets.json')
    const body = JSON.stringify({ LOCAL_JWT_SECRET: 42, TOKEN_ENCRYPTION_KEY: 'k' })
    writeFileSync(file, body)
    expect(() => loadOrCreateSecrets(dir, {})).toThrow(/corrupt/)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })

  it('corrupt file throws and is not overwritten', () => {
    const file = join(dir, 'secrets.json')
    writeFileSync(file, '{not json')
    expect(() => loadOrCreateSecrets(dir, {})).toThrow(/secrets\.json/)
    expect(readFileSync(file, 'utf8')).toBe('{not json')
  })

  it('unwritable dir throws naming the path', () => {
    chmodSync(dir, 0o500)
    const target = join(dir, 'sub')
    expect(() => loadOrCreateSecrets(target, {})).toThrow(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})
