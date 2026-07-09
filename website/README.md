# Waffled websites

Two independent static sites, each its own Astro project and its own Cloudflare
Pages deployment:

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

## Hosting — two Cloudflare Pages projects, one repo

Both sites live in this one repo. Create **two separate Pages projects** connected
to the same repository, each scoped to its own subfolder so pushes only rebuild
the site that changed.

> Requires **Build system version 2** (Pages → project → Settings → Build → Build
> system version) — monorepo build-watch-paths need V2.

### Project A — docs (`docs.waffled.app`)

Workers & Pages → **Create** → **Pages** → Connect to Git → this repo, then:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | **Astro** |
| **Root directory** | `website/docs` |
| Build command | `npm run build` |
| Build output directory | `dist` |

Then **Settings → Build → Build watch paths**:

| | Value |
| --- | --- |
| Include paths | `website/docs/*` |
| Exclude paths | *(empty)* |

Custom domain: **Custom domains → Set up a domain → `docs.waffled.app`**.
(Optional) set env var `DOCS_SITE=https://docs.waffled.app` so canonical/sitemap
URLs are absolute.

### Project B — home (`waffled.app`)

Same flow, a **second** Pages project:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | **Astro** |
| **Root directory** | `website/home` |
| Build command | `npm run build` |
| Build output directory | `dist` |

**Settings → Build → Build watch paths**:

| | Value |
| --- | --- |
| Include paths | `website/home/*` |
| Exclude paths | *(empty)* |

Custom domain: `waffled.app` (and `www.waffled.app` → redirect). (Optional) env
var `HOME_SITE=https://waffled.app`.

### How the path scoping works

Build watch paths are **relative to the repository root** and a single `*`
matches across `/`. So `website/home/*` matches `website/home/src/pages/index.astro`
but **not** `website/docs/...`. Cloudflare evaluates excludes first, then
includes, and only builds if a changed path survives. Net effect:

- push touching only `website/docs/**` → **docs** rebuilds, home is skipped
- push touching only `website/home/**` → **home** rebuilds, docs is skipped
- push touching `apps/**` only → **neither** website rebuilds

### Migrating the existing project

The current single Pages project points at root directory `website`. Repoint it to
`website/docs` and add the `website/docs/*` build watch path (that becomes Project
A), then create the new Project B for `website/home`. No need to delete and
recreate — just update the existing project's root directory + watch paths.

## Future: `api.waffled.app`

The docs already publish an API reference page. If we later want a standalone,
generated API explorer (e.g. from an OpenAPI spec), add a third `website/api/`
project with root directory `website/api` and include path `website/api/*` — the
same pattern.
