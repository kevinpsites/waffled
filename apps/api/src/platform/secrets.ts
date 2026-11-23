import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GENERATORS = {
  LOCAL_JWT_SECRET: () => randomBytes(48).toString('base64'),
  TOKEN_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
} as const

type SecretName = keyof typeof GENERATORS
const NAMES = Object.keys(GENERATORS) as SecretName[]

function readStored(file: string): Partial<Record<SecretName, string>> | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`)
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch (err) {
    // Never regenerate over a corrupt file: that would silently invalidate every session and stored token.
    throw new Error(`${file} is corrupt (${(err as Error).message}); fix or remove it`)
  }
}

/** Fills missing LOCAL_JWT_SECRET / TOKEN_ENCRYPTION_KEY in `env` from `${dataDir}/secrets.json`, generating and persisting any that are absent. Env values always win. */
export function loadOrCreateSecrets(dataDir: string, env: NodeJS.ProcessEnv): void {
  const file = join(dataDir, 'secrets.json')
  const stored = readStored(file) ?? {}
  const merged: Partial<Record<SecretName, string>> = { ...stored }
  let changed = false

  for (const name of NAMES) {
    if (!merged[name]) {
      merged[name] = GENERATORS[name]()
      changed = true
    }
  }

  if (changed) {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (err) {
      throw new Error(`Cannot write ${file}: ${(err as Error).message}`)
    }
  }

  for (const name of NAMES) {
    if (!env[name]) env[name] = merged[name]
  }
}
