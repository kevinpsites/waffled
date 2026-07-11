import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('Compose network defaults', () => {
  it('keeps database and direct API ports on loopback', async () => {
    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')
    expect(compose).toContain('127.0.0.1:${POSTGRES_PORT:-5432}:5432')
    expect(compose).toContain('127.0.0.1:${API_PORT:-3000}:3000')
  })

  it('publishes PowerSync through Caddy instead of the raw service', async () => {
    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')
    const powersync = compose.split('\n  powersync:')[1].split('\n  caddy:')[0]
    const caddy = compose.split('\n  caddy:')[1].split('\n  backup:')[0]
    expect(powersync).not.toMatch(/\n    ports:/)
    expect(caddy).toContain('${POWERSYNC_PORT:-8090}:8090')
    expect(caddy).toContain('POWERSYNC_CADDY_ADDRESS')

    const caddyfile = await readFile(resolve(root, 'infra/compose/caddy/Caddyfile'), 'utf8')
    expect(caddyfile).toContain('{$POWERSYNC_CADDY_ADDRESS}')
    expect(caddyfile).toContain('reverse_proxy powersync:8080')
  })

  it('keeps the Google OAuth callback behind the public Caddy ingress', async () => {
    const caddyfile = await readFile(resolve(root, 'infra/compose/caddy/Caddyfile'), 'utf8')
    expect(caddyfile).toMatch(/handle \/auth\/google\/\*/)
    expect(caddyfile).toContain('reverse_proxy api:3000')

    const example = await readFile(resolve(root, 'infra/compose/.env.example'), 'utf8')
    expect(example).toContain('GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:8080/auth/google/calendar/callback')
  })

  it('configures the PowerSync Caddy listener in every setup mode', async () => {
    const cli = await readFile(resolve(root, 'waffled'), 'utf8')
    expect(cli.match(/set_env_var POWERSYNC_CADDY_ADDRESS/g)?.length).toBeGreaterThanOrEqual(3)
    expect(cli).toContain('set_env_var POWERSYNC_CADDY_ADDRESS "https://$host:8090"')
    expect(cli).toContain('ensure_env; ensure_powersync_proxy_env; export_build_meta')
  })
})
