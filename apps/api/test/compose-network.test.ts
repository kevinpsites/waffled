import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

    // The public demo box pins its own https sync hostname in the untracked
    // infra/compose/.env.demo, where the derive would hand out the wrong one. Its
    // launcher has its own env file and runs none of the ./waffled upgrade bridges,
    // so nothing here can reach it. (The https shape is protected too — see the
    // replacement table below.)
    const demoCli = await readFile(resolve(root, 'waffled-demo'), 'utf8')
    expect(demoCli).not.toContain('ensure_')
  })

  // Writing an empty value in `setup` only helps NEW installs. Every household that
  // ran setup before this release still has the old pinned URL — localhost (mode 1)
  // or a LAN IP that DHCP may since have reassigned (mode 2) — and would upgrade into
  // exactly the bug the derive fixes. Clear those on the way in, like the Google
  // callback bridge above.
  it('clears a setup-generated sync URL and never a deliberate one', () => {
    const cli = resolve(root, 'waffled')
    const cases = [
      'http://localhost:8090',            // setup mode 1
      'http://127.0.0.1:8090',            // hand-written equivalent
      'http://192.168.4.150:8090',        // setup mode 2, stale after a DHCP change
      'https://sync.example.com',         // operator's own hostname/TLS
      'https://waffled.example.com:8090', // setup mode 3
      'http://sync.example.com:8090',     // a hostname is a choice, scheme aside
      'http://192.168.4.150:9443',        // a port we didn't publish PowerSync on
      'http://192.168.4.150:8090/sync',   // a path means a proxy in front
      'off',                              // "this deployment has no PowerSync"
    ]
    // Sourcing the CLI resets $@ (it re-parses its own args), so stash ours first.
    const result = execFileSync('bash', ['-c', `
      script="$1"; shift; urls=("$@")
      source "$script" help >/dev/null
      for url in "\${urls[@]}"; do
        set +e
        out="$(powersync_url_replacement "$url" 8090)"; code=$?
        set -e
        printf '%s %s [%s]\n' "$url" "$code" "$out"
      done
    `, '_', cli, ...cases], { encoding: 'utf8' })

    expect(result).toBe([
      'http://localhost:8090 0 []',
      'http://127.0.0.1:8090 0 []',
      'http://192.168.4.150:8090 0 []',
      'https://sync.example.com 1 []',
      'https://waffled.example.com:8090 1 []',
      'http://sync.example.com:8090 1 []',
      'http://192.168.4.150:9443 1 []',
      'http://192.168.4.150:8090/sync 1 []',
      'off 1 []',
      '',
    ].join('\n'))
  })

  it('rewrites an installed .env in place, honouring its own POWERSYNC_PORT', () => {
    const cli = resolve(root, 'waffled')
    const dir = mkdtempSync(join(tmpdir(), 'waffled-env-'))
    const envFile = join(dir, '.env')
    writeFileSync(envFile, [
      'POSTGRES_PASSWORD=keep-me',
      'POWERSYNC_PORT=9443',
      'POWERSYNC_PUBLIC_URL=http://192.168.4.150:9443',
      '',
    ].join('\n'))

    // ENV_FILE is set after sourcing, so the real infra/compose/.env is never touched.
    const out = execFileSync('bash', ['-c', `
      script="$1"; env_file="$2"
      source "$script" help >/dev/null
      ENV_FILE="$env_file"
      ensure_powersync_url_env
    `, '_', cli, envFile], { encoding: 'utf8' })

    const after = readFileSync(envFile, 'utf8')
    expect(after).toContain('POWERSYNC_PUBLIC_URL=\n')
    expect(after).toContain('POSTGRES_PASSWORD=keep-me')
    expect(out).toContain('192.168.4.150:9443')

    // A second pass is a no-op — nothing left to clear, and no stray key appended.
    writeFileSync(envFile, 'POWERSYNC_PORT=8090\n')
    execFileSync('bash', ['-c', `
      script="$1"; env_file="$2"
      source "$script" help >/dev/null
      ENV_FILE="$env_file"
      ensure_powersync_url_env
    `, '_', cli, envFile], { encoding: 'utf8' })
    expect(readFileSync(envFile, 'utf8')).toBe('POWERSYNC_PORT=8090\n')
  })

  it('keeps the Google OAuth callback behind the public Caddy ingress', async () => {
    const caddyfile = await readFile(resolve(root, 'infra/compose/caddy/Caddyfile'), 'utf8')
    expect(caddyfile).toMatch(/handle \/auth\/google\/\*/)
    expect(caddyfile).toContain('reverse_proxy api:3000')

    const example = await readFile(resolve(root, 'infra/compose/.env.example'), 'utf8')
    expect(example).toContain('GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:8080/auth/google/calendar/callback')
  })

  it('authorizes signed media URLs before serving private files', async () => {
    const caddyfile = await readFile(resolve(root, 'infra/compose/caddy/Caddyfile'), 'utf8')
    expect(caddyfile).toContain('forward_auth api:3000')
    expect(caddyfile).toContain('uri /api/media/authorize')
    expect(caddyfile).toContain('Cache-Control "private, max-age=300, no-transform"')
    expect(caddyfile).not.toContain('Cache-Control "public, max-age=31536000, immutable"')

    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')
    expect(compose).toContain('BACKUP_INCLUDE_MEDIA: ${BACKUP_INCLUDE_MEDIA:-true}')
  })

  it('configures the PowerSync Caddy listener in every setup mode', async () => {
    const cli = await readFile(resolve(root, 'waffled'), 'utf8')
    expect(cli.match(/set_env_var POWERSYNC_CADDY_ADDRESS/g)?.length).toBeGreaterThanOrEqual(3)
    expect(cli).toContain('set_env_var POWERSYNC_CADDY_ADDRESS "https://$host:8090"')
    expect(cli).toContain('ensure_env; ensure_powersync_proxy_env; ensure_powersync_url_env; ensure_google_callback_env; export_build_meta')
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
