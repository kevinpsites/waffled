// Integration test for the Auth0 RS256 path, without touching real Auth0.
// A wiremock container serves a JWKS document built from a keypair we generate
// here; the API (in auth0 mode, pointed at wiremock) must accept tokens signed
// by the published key and reject everything else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import jwt from 'jsonwebtoken'

const CLAIM = 'https://waffled.app/household_id'
const AUDIENCE = 'waffled-api'
const ISSUER = 'https://test.auth0.local/'
const KID = 'test-key-1'

let wiremock: StartedTestContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let publishedKey: string
let unpublishedKey: string

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, headers: Record<string, string> = {}) {
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

beforeAll(async () => {
  // 1. Keypair whose public half we publish as a JWK, plus an unrelated key.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publishedKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const jwk = {
    ...(pair.publicKey as KeyObject).export({ format: 'jwk' }),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  }
  unpublishedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string

  // 2. wiremock serving GET /.well-known/jwks.json
  wiremock = await new GenericContainer('wiremock/wiremock:3.9.1')
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/__admin/mappings', 8080))
    .start()
  const base = `http://${wiremock.getHost()}:${wiremock.getMappedPort(8080)}`
  const stub = await fetch(`${base}/__admin/mappings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request: { method: 'GET', url: '/.well-known/jwks.json' },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: { keys: [jwk] },
      },
    }),
  })
  expect(stub.status).toBe(201)

  // 3. Boot the app in auth0 mode, pointed at wiremock. Env must be set before
  //    importing app, since config reads it at module load.
  process.env.AUTH0_DOMAIN = 'test.auth0.local'
  process.env.AUTH0_AUDIENCE = AUDIENCE
  process.env.AUTH0_ISSUER = ISSUER
  process.env.AUTH0_JWKS_URI = `${base}/.well-known/jwks.json`
  app = (await import('../src/app')).default
})

afterAll(async () => {
  await wiremock?.stop()
})

describe('auth — Auth0 RS256 via wiremock JWKS', () => {
  it('healthz reports auth0 mode', async () => {
    const res = await call('GET', '/healthz')
    expect(JSON.parse(res.body)).toMatchObject({ authMode: 'auth0' })
  })

  it('accepts an RS256 token whose key is published in the JWKS', async () => {
    const token = jwt.sign({ [CLAIM]: 'hh-rs-1' }, publishedKey, {
      algorithm: 'RS256',
      keyid: KID,
      subject: 'auth0|abc',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '1h',
    })
    const res = await call('GET', '/api/me', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ sub: 'auth0|abc' })
  })

  it('rejects an RS256 token signed by an unpublished key (401)', async () => {
    const token = jwt.sign({ [CLAIM]: 'hh-rs-1' }, unpublishedKey, {
      algorithm: 'RS256',
      keyid: KID,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: '1h',
    })
    const res = await call('GET', '/api/me', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a token with the wrong audience (401)', async () => {
    const token = jwt.sign({ [CLAIM]: 'hh-rs-1' }, publishedKey, {
      algorithm: 'RS256',
      keyid: KID,
      issuer: ISSUER,
      audience: 'someone-else',
      expiresIn: '1h',
    })
    const res = await call('GET', '/api/me', { authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(401)
  })
})
