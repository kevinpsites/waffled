import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const composeDir = resolve(import.meta.dirname, '../../../infra/compose')

describe('trusted client address proxy boundary', () => {
  it('makes Caddy replace caller-supplied forwarding chains', async () => {
    const caddyfile = await readFile(resolve(composeDir, 'caddy/Caddyfile'), 'utf8')
    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}')
  })

  it('does not publish direct API access on external host interfaces', async () => {
    const compose = await readFile(resolve(composeDir, 'docker-compose.yml'), 'utf8')
    expect(compose).toContain('127.0.0.1:${API_PORT:-3000}:3000')
    expect(compose).not.toContain('"${API_PORT:-3000}:3000"')
  })
})
