// Capture a consistent set of Waffled web/kiosk screenshots from a running demo
// stack, for use on the marketing site and docs. Reproducible source of truth:
// re-run this whenever the UI changes, then re-copy the shots each site uses
// into its own public/screenshots (the two sites build independently — see
// website/README.md § Screenshots).
//
// Usage:
//   node website/scripts/capture-screenshots.mjs [outDir]
// Env (defaults target the local Seinfelds demo stack on :8081):
//   BASE=http://localhost:8081  EMAIL=jerry@seinfeld.demo  PASSWORD=seinfeld123
//
// Requires playwright-core and a Chromium/headless-shell (set CHROME to override).

import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:8081';
const EMAIL = process.env.EMAIL || 'jerry@seinfeld.demo';
const PASSWORD = process.env.PASSWORD || 'seinfeld123';
const OUT = process.argv[2] || 'website/scripts/.out';
const CHROME = process.env.CHROME ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const VIEWS = [
  { route: '/',         name: 'today' },
  { route: '/calendar', name: 'calendar' },
  { route: '/meals',    name: 'meals' },
  { route: '/tasks',    name: 'chores' },
  { route: '/lists',    name: 'lists' },
  { route: '/pantry',   name: 'pantry' },
  { route: '/goals',    name: 'goals' },
  { route: '/photos',   name: 'photos' },
];

const res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const { accessToken, refreshToken } = await res.json();
if (!accessToken) throw new Error('login failed: ' + (await res.text()));
console.log('logged in');

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await ctx.addInitScript(([a, r]) => {
  localStorage.setItem('waffled.access', a);
  localStorage.setItem('waffled.refresh', r);
}, [accessToken, refreshToken]);

const page = await ctx.newPage();
for (const v of VIEWS) {
  try { await page.goto(BASE + v.route, { waitUntil: 'networkidle', timeout: 15000 }); }
  catch { /* PowerSync holds a connection open → networkidle times out; fine */ }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${v.name}.png` });
  console.log(`  ${v.name}.png`);
}

// Rewards is a tab on the Tasks page (not a route) — open Tasks, click Rewards.
try { await page.goto(BASE + '/tasks', { waitUntil: 'networkidle', timeout: 15000 }); } catch {}
await page.waitForTimeout(1500);
try { await page.getByRole('button', { name: 'Rewards', exact: true }).click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/rewards.png` });
console.log('  rewards.png');

await browser.close();
console.log('done →', OUT);
