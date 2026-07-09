# Waffled websites

Two independent static sites, each its own Astro project deployed to its own
Cloudflare project (a Worker or a Pages project — see Hosting):

| Folder | Site | Domain | Stack |
| --- | --- | --- | --- |
| [`home/`](home) | Marketing landing | `waffled.app` | Astro (plain) |
| [`docs/`](docs) | User & operator docs | `docs.waffled.app` | Astro **Starlight** |

They share the same brand tokens (warm cream canvas, coral accent, serif display)
but build and deploy separately, so a docs edit never rebuilds the landing and
vice-versa. Engineering docs stay in the repo's top-level `docs/` folder — not
here.

## Local

Each project is standalone — `cd` in first:

```bash
cd website/home && npm install && npm run dev   # → localhost:4321
cd website/docs && npm install && npm run dev   # → localhost:4321
```

## Hosting — two Cloudflare projects, one repo

Each site deploys to its **own** Cloudflare project connected to this repo. A
project can be a **Worker (static assets)** or a **Pages** project — both serve a
static Astro `dist/` identically, and both support the build-watch-path scoping
below. Cloudflare is consolidating on **Workers**, so if one site is already a
Worker, set the other up the same way for consistency.

| Project | Builds | Serves | Domain |
| --- | --- | --- | --- |
| **docs** | `website/docs` | `website/docs/dist` | `docs.waffled.app` |
| **home** | `website/home` | `website/home/dist` | `waffled.app` |

For **each** project:

1. **Connect it to this repo** — Workers: *Create → Workers → Import a repository*;
   Pages: *Create → Pages → Connect to Git*. Production branch `main`.
2. **Build the subfolder** — run `npm run build` in the site's folder, serving its
   `dist/`. On **Pages**: set **Root directory** = `website/docs` (or `website/home`),
   framework **Astro**, output `dist`. On **Workers**: each site ships a committed
   **`wrangler.jsonc`** (`home/wrangler.jsonc`, `docs/wrangler.jsonc`) pointing
   `assets.directory` at `./dist` — this is what makes `npx wrangler deploy` find the
   built files. **Set each file's `name` to match its Worker's name in the dashboard.**
   The file holds **no secrets** (secrets, if ever needed, live in the dashboard /
   `wrangler secret`, never in the file).
3. **Scope builds so they don't rebuild each other** — **Settings → Build → Build
   watch paths → Include**: `website/docs/*` for docs, `website/home/*` for home
   (Exclude empty). Needs **Build system v2** on Pages; the same Build settings exist
   on Workers.
4. **Custom domain** — `docs.waffled.app` on docs, `waffled.app` (+ `www` → apex
   redirect) on home.
5. *(optional)* env vars for absolute canonical/sitemap URLs:
   `DOCS_SITE=https://docs.waffled.app`, `HOME_SITE=https://waffled.app`.

### How the path scoping works

Build watch paths are **relative to the repository root** and a single `*`
matches across `/`. So `website/home/*` matches `website/home/src/pages/index.astro`
but **not** `website/docs/...`. Cloudflare evaluates excludes first, then
includes, and only builds if a changed path survives. Net effect:

- push touching only `website/docs/**` → **docs** rebuilds, home is skipped
- push touching only `website/home/**` → **home** rebuilds, docs is skipped
- push touching `apps/**` only → **neither** website rebuilds

### Migrating the existing project

The original single project pointed at `website`. Repoint it to build `website/docs`
and add the `website/docs/*` watch path (that becomes the **docs** project), then
create a **second** project for `website/home`. No need to delete and recreate —
just update the existing project's build folder + watch paths.

## Screenshots & assets

> ⚠️ **The same screenshot is vendored into several places — if you update one,
> update (or re-copy) them all.** The two sites build independently, so images
> can't be shared across them; each keeps its own copy under `public/screenshots`.

Where the source of truth lives:

| Kind | Source of truth | Vendored copies (what actually ships) |
| --- | --- | --- |
| **Web / kiosk** shots | Regenerate with `scripts/capture-screenshots.mjs` against a running demo stack (the UI is the truth) | `home/public/screenshots`, `docs/public/screenshots`, `../docs/product/screenshots` (README `demo.gif`) |
| **iOS / iPad** shots | `../apps/ios/app-store/screenshots` (the App Store assets) | copied into `home/public/screenshots` / `docs/public/screenshots` where used |

So to refresh a screenshot: re-capture (or re-export) it at the source, then
**copy it into every `public/screenshots` that references it** and, if it's in
the README montage, rebuild `demo.gif`. Grep the repo for the filename first to
find every copy.

Regenerate the web set (needs `playwright-core` + a Chromium, and a demo stack —
see the [Demo seed](../docs/product/) notes for the `:8081` stack):

```bash
cd website && node scripts/capture-screenshots.mjs .out   # writes today.png, calendar.png, …
# then copy the ones each site uses into home/public/screenshots and docs/public/screenshots
```

The README `demo.gif` is built from that set with ffmpeg (a hard-cut slideshow of
Today → Calendar → Chores → Meals → Pantry).

## Future: `api.waffled.app`

The docs already publish an API reference page. If we later want a standalone,
generated API explorer (e.g. from an OpenAPI spec), add a third `website/api/`
project with root directory `website/api` and include path `website/api/*` — the
same pattern.
