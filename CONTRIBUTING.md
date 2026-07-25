# Contributing to Waffled

Thanks for your interest in Waffled — a self-hosted family hub.

**The full contributing guide lives on the docs site:
[waffled.app/developer/contributing](https://waffled.app/developer/contributing/).** It covers
local setup, running the tests, commit conventions, CI/CD, the release process, and how to open
a good PR.

Quick version:

- The stack runs via the root `./waffled` CLI — `./waffled up` (first run bootstraps
  `infra/compose/.env` with generated secrets), `./waffled web` for Vite HMR. Requires
  **Docker** and **Node 24** for source development (the API container itself
  remains on Node 20).
- Run the checks before opening a PR: `cd apps/api && npm test && npm run typecheck`, and the
  same in `apps/web`. For iOS, `xcodebuild test -project Waffled.xcodeproj -scheme Waffled`.
- Use conventional-commit messages with a scope; keep PRs focused; add tests for behavior
  changes; log user-facing changes in `CHANGELOG.md` under `[Unreleased]`.
- Security issues: see [`SECURITY.md`](SECURITY.md) — report those **privately**, not as public
  issues.

By contributing you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md), and that your
contributions will be licensed under the project's [AGPL-3.0 license](LICENSE).
