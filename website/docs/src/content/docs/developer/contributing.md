---
title: Contributing
description: How to contribute code and docs to Waffled.
---

Thanks for your interest in Waffled. This guide covers how to get set up, run the
checks, and open a good PR. When in doubt, match the surrounding code.

Waffled is licensed under the **GNU AGPL-3.0**, and by contributing you agree
that your contributions will be licensed under the same
[AGPL-3.0 license](https://github.com/evan-ribbey/waffled-ng/blob/main/LICENSE).

## Local setup

Waffled runs as a two-container Docker Compose stack from the root `compose.yaml`.
Requires **Docker Compose v2.24+** and **Node 24** for source development.

```bash
git clone <repo-url> waffled
cd waffled
docker compose up -d --build   # builds the waffled image from source and starts the stack
cd apps/web && npm run dev      # Vite HMR for apps/web
```

See [Local development](/developer/local-development/) for the full workflow.

## Project layout

- `apps/api` — backend (TypeScript, lambda-api, bundled with esbuild; Postgres
  migrations via node-pg-migrate). Its own `package.json` / `package-lock.json`.
- `apps/web` — kiosk / web app (React + Vite). Its own `package.json`.
- `compose.yaml` / `Dockerfile` — the two-container stack and the single `waffled` image.
- `infra/backup` — the optional backup image.
- `website` — this documentation site (Astro Starlight).
- `docs` — project documentation.

This is **not** an npm-workspaces monorepo — `apps/api` and `apps/web` each
manage their own dependencies with `npm`.

## Running tests

Run the checks for the relevant app before opening a PR — CI runs all of it.

```bash
# API — vitest + Testcontainers integration (needs Docker running)
cd apps/api && npm test
cd apps/api && npm run typecheck

# Web — vitest / jsdom
cd apps/web && npm test
cd apps/web && npm run typecheck
```

## Commits

Use conventional-commits-style messages with a **scope**:

```
feat(meals): add recipe scheduling
fix(chores): correct approval ordering
docs: expand contributing guide
ci: cache node_modules
```

## Pull requests

- **Keep PRs focused** — one logical change per PR is much easier to review.
- **CI must pass** (tests + typecheck for both apps).
- **Add tests** for behavior changes — API changes get integration tests, web
  changes get component / unit tests.
- **Update `CHANGELOG.md`** — add an entry under the `[Unreleased]` section.
- **Update docs** when you change behavior or config.

## Questions & security

Open a **GitHub Issue** for bugs and feature requests, or start a **GitHub
Discussion** for questions and ideas. For **security issues**, follow
`SECURITY.md` and report privately — **not** as a public issue. All contributors
are expected to follow the `CODE_OF_CONDUCT.md`.

## CI/CD

- **`.github/workflows/ci.yml`** runs on PRs and on push to `main`: migration hygiene,
  typechecking, web tests, API integration tests, and a compose smoke test.
- **`.github/workflows/publish-images.yml`** runs **only on `v*` tags** (or
  manual dispatch). It builds two multi-arch (amd64 + arm64) GHCR images —
  `waffled` (the app, with the web SPA baked in) and `waffled-backup` — and cuts a
  GitHub Release.

## Release process

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) and
[SemVer](https://semver.org/). To cut a release:

1. Make sure every user-facing change is described under `[Unreleased]` in
   `CHANGELOG.md`, then start from a clean `main` checkout.
2. Run the release script with the version you want:

   ```bash
   scripts/release.sh X.Y.Z
   ```

The script dates the changelog, bumps the `apps/api` and `apps/web` versions,
and creates the release commit and `v*` tag. It never pushes: it prints the push
command. The pushed tag triggers `publish-images.yml`, which builds the GHCR images and
creates the GitHub Release.

## See also

- [Architecture](/developer/architecture/) — the big picture
- [Building a module](/concepts/extensibility/) — adding a feature
- [Local development](/developer/local-development/) — the dev workflow
