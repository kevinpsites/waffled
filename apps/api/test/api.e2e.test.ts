// Full end-to-end test of the shipped artifact: Testcontainers builds the api
// image from the Dockerfile, runs it, and we drive it over real HTTP — exactly
// how Caddy and the iOS app will reach it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import jwt from 'jsonwebtoken'

const SECRET = 'e2e-secret-change-me'
const CLAIM = 'https://nook.app/household_id'
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let container: StartedTestContainer
let baseUrl: string

beforeAll(async () => {
  const image = await GenericContainer.fromDockerfile(apiDir).build()
  container = await image
    .withEnvironment({ LOCAL_JWT_SECRET: SECRET, PORT: '3000' })
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
    issuer: 'nook-local',
    audience: 'nook-api',
    expiresIn: '1h',
  })
}

describe('api image — real container over HTTP', () => {
  it('serves /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, service: 'nook-api', authMode: 'local' })
  })

  it('401s without a token', async () => {
    const res = await fetch(`${baseUrl}/api/me`)
    expect(res.status).toBe(401)
  })

  it('returns household context with a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/me`, {
      headers: { authorization: `Bearer ${mint('hh-e2e-9')}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sub: 'dev|kevin', householdId: 'hh-e2e-9' })
  })
})
