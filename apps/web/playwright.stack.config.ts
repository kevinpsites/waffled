import { defineConfig, devices } from '@playwright/test'

// Runs the same specs against the real Docker stack instead of Vite's preview
// server: `npx playwright test -c playwright.stack.config.ts`.
//
// Worth having as its own config because the two servers differ in ways this app
// is sensitive to. Caddy serves the SPA with `try_files {path} /index.html`, so a
// missing chunk comes back as 200 + HTML rather than a 404; it stamps assets
// `Cache-Control: immutable`; and it does not send the `Vary: Origin` that Vite's
// preview server does. Passing under preview therefore says little about what a
// kitchen display actually runs.
//
// Assumes the stack is already up and rebuilt — the web app is baked into the
// caddy image, so `:8080` serves whatever was last built into it:
//   docker build -f infra/compose/caddy/Dockerfile -t waffled-caddy:local-main .
//   docker compose -p waffled -f infra/compose/docker-compose.yml \
//     --project-directory infra/compose up -d --force-recreate --no-deps caddy
//
// The specs mock /api/** at the browser, so this needs no real credentials and
// writes nothing to the household database.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: process.env.WAFFLED_STACK_URL ?? 'http://localhost:8080',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
