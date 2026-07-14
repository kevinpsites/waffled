import { defineConfig, configDefaults } from 'vitest/config'

// The api suite is integration-heavy: most files drive the real HTTP routes against
// a Postgres. We boot ONE Postgres once (test/global-setup.ts) and give each file its
// own isolated database (test/helpers/pg.ts), so files can run in parallel without the
// old per-file container-boot cost or Docker/port contention. A bounded fork pool keeps
// Postgres connection use and Docker load sane — correctness over max concurrency.
//
// api.e2e.test.ts is excluded here: it builds the Dockerfile via Testcontainers (minutes)
// and runs on its own — see vitest.e2e.config.ts + the `api-e2e` CI job.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/api.e2e.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Signals runMigrations() to skip node-pg-migrate's cluster-wide advisory lock:
    // every test file owns an isolated, single-writer database, so the lock would only
    // serialize otherwise-parallel migrations. See src/migrate.ts.
    env: { WAFFLED_TEST_SHARED_PG: '1' },
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: true,
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
  },
})
