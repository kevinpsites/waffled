import { defineConfig } from 'vitest/config'

// Isolated config for the one slow end-to-end test: api.e2e.test.ts builds the api
// image from the Dockerfile via Testcontainers and drives it over real HTTP. It needs
// neither the shared-Postgres globalSetup nor file parallelism (it's a single file), so
// it runs on its own — invoked by `npm run test:e2e` and the `api-e2e` CI job, in parallel
// with the fast `api-tests` job rather than serialized inside it.
export default defineConfig({
  test: {
    include: ['test/api.e2e.test.ts'],
    testTimeout: 120_000,
    // The beforeAll hook builds the api image from the Dockerfile — a cold build (no
    // layer cache) can take several minutes, so give it generous headroom now that it
    // runs on its own rather than sharing the fast suite's 180s hook budget.
    hookTimeout: 600_000,
  },
})
