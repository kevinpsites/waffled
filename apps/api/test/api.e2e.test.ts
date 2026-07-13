// Full end-to-end test of the shipped artifact: Testcontainers builds the api
// image from the Dockerfile, runs it, and we drive it over real HTTP — exactly
// how Caddy and the iOS app will reach it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import jwt from 'jsonwebtoken'

const SECRET = 'e2e-secret-change-me-at-least-32-characters'
const TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0x42).toString('base64')
const POWERSYNC_JWT_PRIVATE_KEY = Buffer.from(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  })
).toString('base64')
const CLAIM = 'https://waffled.app/household_id'
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let container: StartedTestContainer
let baseUrl: string

beforeAll(async () => {
  const image = await GenericContainer.fromDockerfile(apiDir).build()
  container = await image
    .withEnvironment({
      LOCAL_JWT_SECRET: SECRET,
      TOKEN_ENCRYPTION_KEY,
      POWERSYNC_JWT_PRIVATE_KEY,
      PORT: '3000',
    })
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp('/healthz', 3000).forStatusCode(200))
    .start()
  baseUrl = `http://${container.getHost()}:${container.getMappedPort(3000)}`
})

afterAll(async () => {
  await container?.stop()
})

function mint(household: string, sub = 'dev|kevin'): string {
  return jwt.sign({ [CLAIM]: household }, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'waffled-local',
    audience: 'waffled-api',
    expiresIn: '1h',
  })
}

describe('api image — real container over HTTP', () => {
  it('serves /healthz with build + db info', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version?: { sha?: string }; db?: string }
    expect(body).toMatchObject({ ok: true, service: 'waffled-api', authMode: 'local' })
    expect(body.version?.sha).toBeTruthy()
    // No DATABASE_URL in this container → the readiness ping reports db down,
    // but liveness (HTTP 200) is unaffected.
    expect(['up', 'down']).toContain(body.db)
  })

  it('401s without a token', async () => {
    const res = await fetch(`${baseUrl}/api/me`)
    expect(res.status).toBe(401)
  })

  it('echoes the principal with a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { authorization: `Bearer ${mint('hh-e2e-9')}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sub: 'dev|kevin' })
  })
})
