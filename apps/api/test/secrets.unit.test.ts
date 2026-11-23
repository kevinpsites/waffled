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
    const preset = 'x'.repeat(40)
    const env: NodeJS.ProcessEnv = { LOCAL_JWT_SECRET: preset }
    loadOrCreateSecrets(dir, env)
    expect(env.LOCAL_JWT_SECRET).toBe(preset)
    const fresh: NodeJS.ProcessEnv = {}
    loadOrCreateSecrets(dir, fresh)
    expect(fresh.LOCAL_JWT_SECRET).not.toBe(preset)
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
