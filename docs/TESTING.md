# Testing

**Practice: test-first, integration-first.** From chunk 2.3 onward, write the failing
integration test before the implementation, then build until it's green.

## Principles

- **Real infrastructure, not mocks of our own code.** Tests exercise actual HTTP
  endpoints against real dependencies (Postgres, the built api image) rather than
  stubbing our internals.
- **Containers via [Testcontainers](https://node.testcontainers.org/).** Tests own the
  lifecycle of ephemeral containers per run — hermetic, CI-friendly, no reliance on a
  pre-started stack. (Needs Docker running.)
- **External services we don't control:** use a real container if one exists; otherwise
  **[wiremock](https://wiremock.org/)** to stand in for the HTTP API. This is how we test
  Auth0 (JWKS) today and how we'll test Google Calendar later — never hit the real service.
- **Runner: [Vitest](https://vitest.dev/)** (`vitest run`), TS-native.

## Layout (per app)

```
apps/api/
  vitest.config.ts          # sequential files, generous timeouts for containers
  test/
    *.local.test.ts         # fast in-process component tests (no container)
    *.integration.test.ts   # one external dependency, real container (e.g. wiremock JWKS)
    *.e2e.test.ts           # the built image over real HTTP (Testcontainers builds it)
```

## Running

```bash
just test          # or: cd apps/api && npm test
cd apps/api && npm run test:watch
```

## Patterns established in `apps/api`

- **Auth0 RS256 without Auth0** (`test/jwks.integration.test.ts`): generate an RSA keypair,
  publish the public half as a JWK via wiremock, point the API at it with `AUTH0_JWKS_URI`,
  and assert published-key tokens pass while unpublished-key / wrong-audience tokens fail.
- **Shipped-artifact e2e** (`test/api.e2e.test.ts`): Testcontainers builds the Dockerfile,
  runs the container, and drives it over HTTP exactly as Caddy / iOS will.
- **Config is env-injectable** so tests can redirect external endpoints (`AUTH0_JWKS_URI`,
  `AUTH0_ISSUER`) at a local mock — design new code the same way.

> Note: Testcontainers pulls dev-only dependencies with known advisories. They never ship —
> the runtime image is the esbuild bundle with no `node_modules`.
