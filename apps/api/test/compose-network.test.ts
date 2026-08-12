import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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

  // The api DERIVES the sync URL from x-forwarded-proto/-host, and oidc.ts builds
  // redirect URLs from the same pair — so what a caller may put in them matters.
  // caddy:2 already overwrites both for untrusted clients, but the Dockerfile tracks
  // that tag floating; pinning it here makes the guarantee ours. {hostport}, not
  // {host}: {host} drops the port and OIDC uses the value verbatim.
  it('overwrites caller-supplied forwarding headers on the API route', async () => {
    const caddyfile = await readFile(resolve(root, 'infra/compose/caddy/Caddyfile'), 'utf8')
    const api = caddyfile.split('handle /api/*')[1].split('handle /auth/google/*')[0]
    expect(api).toContain('header_up X-Forwarded-For {remote_host}')
    expect(api).toContain('header_up X-Forwarded-Host {hostport}')
    expect(api).toContain('header_up X-Forwarded-Proto {scheme}')
  })

  it('leaves the sync URL unset by default so the api derives it per device', async () => {
    // A baked-in http://localhost:8090 would win over the derive and put every
    // non-local device back on "Offline". The api still needs POWERSYNC_PORT to
    // know which published port to point clients at.
    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')
    const api = compose.split('\n  api:')[1].split('\n  powersync:')[0]
    expect(api).toContain('POWERSYNC_PUBLIC_URL: ${POWERSYNC_PUBLIC_URL:-}')
    expect(api).toContain('POWERSYNC_PORT: ${POWERSYNC_PORT:-8090}')

    // …and guided setup only pins it where the derive can't work (its own hostname/TLS).
    const cli = await readFile(resolve(root, 'waffled'), 'utf8')
    expect(cli.match(/set_env_var POWERSYNC_PUBLIC_URL ""/g)).toHaveLength(2)
    expect(cli).toContain('set_env_var POWERSYNC_PUBLIC_URL "https://$host:$ps_port"')
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
    expect(cli).toContain('ensure_env; ensure_powersync_proxy_env; ensure_google_callback_env; export_build_meta')
  })

  it('migrates only the legacy Google callback and preserves custom callbacks', () => {
    const cli = resolve(root, 'waffled')
    const result = execFileSync('bash', ['-c', `
      source "$1" help >/dev/null
      google_callback_replacement \
        http://localhost:3000/auth/google/calendar/callback \
        https://waffled.example.com \
        8080
      printf '\n'
      set +e
      google_callback_replacement \
        https://custom.example.com:3000/auth/google/calendar/callback \
        https://waffled.example.com \
        8080
      printf 'custom=%s' "$?"
    `, '_', cli], { encoding: 'utf8' })

    expect(result).toBe('https://waffled.example.com/auth/google/calendar/callback\ncustom=1')
  })
})
