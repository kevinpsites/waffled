import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('Compose secret defaults', () => {
  it('requires every production secret instead of supplying fallbacks', async () => {
    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')
    expect(compose).toContain('${LOCAL_JWT_SECRET:?')
    expect(compose).toContain('${TOKEN_ENCRYPTION_KEY:?')
    expect(compose).toContain('${POSTGRES_PASSWORD:?')
    expect(compose).toContain('${POWERSYNC_JWT_PRIVATE_KEY:?')
    expect(compose).not.toContain('waffled-local-dev-secret-change-me')
  })

  it('declares and generates a durable PowerSync signing key', async () => {
    const example = await readFile(resolve(root, 'infra/compose/.env.example'), 'utf8')
    expect(example).toMatch(/^POWERSYNC_JWT_PRIVATE_KEY=$/m)
    expect(example).toMatch(/^POSTGRES_PASSWORD=$/m)
    expect(example).not.toContain('POSTGRES_PASSWORD=change-me')

    const cli = await readFile(resolve(root, 'waffled'), 'utf8')
    expect(cli).toContain('openssl genpkey -algorithm RSA')
    expect(cli).toContain('set_env_var POWERSYNC_JWT_PRIVATE_KEY')
    expect(cli).not.toContain('[ -f "$ENV_FILE" ] && return 0')
  })
})
