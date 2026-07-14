# Waffled — repo conventions & gotchas

High-signal notes for anyone (human or AI) working in this repo. This file is
auto-loaded by Claude Code in every session. Add a bullet when a mistake bites
more than once; keep it terse.

**Folder-scoped conventions load lazily** — app-specific gotchas live next to the
code and load only when you work under that folder: `apps/api/CLAUDE.md` (database
migrations), `apps/ios/CLAUDE.md` (SwiftUI reuse, perf traps, XcodeGen, capability
gates), `apps/web/CLAUDE.md` (design-system reuse). The rules below are repo-wide.

## How we start any new work — isolate first (repo-wide)

**Every new piece of work starts in its own git worktree on a fresh branch off `main` —
never edit `main` directly.** Before writing any code: create a worktree that branches
from an up-to-date `main` (e.g. via the EnterWorktree tool, or
`git worktree add .claude/worktrees/<slug> -b <slug> origin/main`), and do all edits,
builds, and commits there. This keeps `main` and other parallel work clean.

**Work is not done until it is TDD'd and green.** Follow the TDD flow below (failing test
first), and before opening a PR **all tests and typechecking must pass** — run the full
test suite (`npm test`) *and* typecheck/build for every app you touched (web: `npm run
build` / `tsc`; api: `npm test` + `tsc`; iOS: `xcodegen generate` then a clean
`xcodebuild`). A red test or a type error means the work isn't finished — do not open the
PR.

## How we develop — TDD is not optional (repo-wide)

**Test-driven development is the way we build here, not a QA step at the end.** For every
behavior change — a new endpoint, a service function, a bug fix, a counting rule — the flow is
always: **write the failing test first → watch it fail → write the minimum logic to make it
pass → refactor.** Do not write implementation before its test exists. Retrofitting a test onto
already-written code is a fallback for closing an *existing* gap, not the workflow — and when you
do it, say so explicitly.

**Prefer integration tests, strongly; unit tests second.** For the API, integration = drive the
real HTTP routes against a throwaway Postgres (`@testcontainers/postgresql` + `runMigrations`,
`app.run(...)`), asserting on responses — the harness in `apps/api/test/*.integration.test.ts`
(e.g. `goals.integration.test.ts`, `goals-health.integration.test.ts`). Reach for a unit test
(`*.unit.test.ts`) only when the logic is genuinely isolated (pure helpers). Run with `npm test`
(vitest) in `apps/api`.

## Git & pull requests (repo-wide)

**Open PRs ready for review — never as drafts.** Use `gh pr create` (no `--draft`); if a
PR was already opened as a draft, promote it with `gh pr ready <n>`. Some agent harnesses
default to draft PRs — that default does **not** apply here; override it. As always, don't
push to `main`, force-push, or merge without being asked.

## Releasing & the changelog (repo-wide)

1. **Log every user/operator-facing change in `CHANGELOG.md` under `## [Unreleased]` as
   you land it** — grouped by Keep-a-Changelog category (Added / Changed / Fixed / Removed
   / Security). `feat:` → Added, `fix:` → Fixed, user-visible `refactor`/`perf`/`chore` →
   Changed; pure-internal churn (`test`/`docs`/internal `chore`) is omitted. Write a **bold
   lead + a plain-language sentence**, synthesizing related commits into one feature-level
   entry — a changelog is for users, not a commit log. Match the existing entries.
2. **When a feature is done, update the docs too — not just the changelog.** A `CHANGELOG.md`
   entry records that something changed; it does **not** teach anyone how to use it. So when you
   finish a user-facing feature (or change one enough that the old docs are now wrong), also
   surface it where users actually look: the **features reference**
   (`website/docs/src/content/docs/reference/features.md`), the **product roadmap**
   (`docs/product/roadmap.md` — move the item from *Planned* to *Done*, or trim it to the part
   still outstanding), and a **how-to page** under the docs site when the feature needs
   explaining (setup, permissions, gotchas — e.g. an iPhone-only capability with an OS
   permission prompt). Match the existing pages' Starlight frontmatter + voice. Ask "if a user
   went looking for this, would they find and understand it?" — if not, the feature isn't done.
   Skip only when nothing user-facing changed (pure internal churn).
3. **Cut a release ONLY with `./waffled release X.Y.Z`** — never hand-bump versions or
   hand-edit the changelog heading, and never move a published tag. That one command is the
   source of truth: it reviews the `[Unreleased]` notes (and **requires ≥1 entry**), dates
   them `## [X.Y.Z]` + opens a fresh `[Unreleased]` + adds the compare link, bumps **every**
   version site (`apps/api` + `apps/web` package.json + lockfiles, `WAFFLED_VERSION` in
   `infra/compose/.env.example`, iOS `MARKETING_VERSION`), commits `release: vX.Y.Z`, tags,
   and prompts to push. Run it **locally on `main`** — the pushed `v*` tag is what triggers
   the GHCR publish workflow (+ Xcode Cloud). Miss one version site by hand and repo/images/
   `.env` silently disagree. The GitHub Release notes are set **automatically** by the
   `release` job in `publish-images.yml`, which lifts the `## [X.Y.Z]` section out of the
   tagged `CHANGELOG.md` (so the notes you approved during `./waffled release` *are* the
   release body) — no manual `gh release edit` needed. It only falls back to GitHub's
   auto-generated notes if that section is missing/empty.
