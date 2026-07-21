import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('container runtime users', () => {
  it('runs the API and backup schedulers as their unprivileged image users', async () => {
    const apiDockerfile = await readFile(resolve(root, 'apps/api/Dockerfile'), 'utf8')
    const backupDockerfile = await readFile(resolve(root, 'infra/compose/backup/Dockerfile'), 'utf8')

    expect(apiDockerfile).toMatch(/^USER node$/m)
    expect(apiDockerfile).not.toContain('--chown=node:node')
    expect(backupDockerfile).toMatch(/^USER postgres$/m)
  })

  it('migrates existing volume ownership before non-root services start', async () => {
    const compose = await readFile(resolve(root, 'infra/compose/docker-compose.yml'), 'utf8')

    expect(compose).toMatch(/^  volume-permissions:$/m)
    expect(compose).toContain('user: "0:0"')
    expect(compose).toContain('chown -R 1000:1000 /data/media')
    expect(compose).toContain('chown -R 999:999 /backups')
    expect(compose.match(/volume-permissions:\n\s+condition: service_completed_successfully/g)).toHaveLength(2)
  })
})
