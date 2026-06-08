import { defineConfig } from 'vitest/config'

// Integration tests spin up real containers (Testcontainers), so timeouts are
// generous and we run files sequentially to avoid port/Docker contention.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
