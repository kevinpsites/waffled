# Kinnook product docs

The user- and operator-facing documentation (overview, quick start, feature matrix,
permissions, extensibility, backup, upgrading, troubleshooting) now lives in the **docs
site** at [`website/`](../../website), built with [Astro Starlight](https://starlight.astro.build).
It's the canonical source and is published to GitHub Pages by
[`.github/workflows/docs.yml`](../../.github/workflows/docs.yml).

To work on the docs: edit the Markdown under `website/src/content/docs/`, then
`cd website && npm run build` (or `npm run dev` for a live preview).

This folder now retains only:

- [`roadmap.md`](./roadmap.md) — what's done, partial, and planned.

For engineering internals see the sibling docs:
[`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../DATA_MODEL.md`](../DATA_MODEL.md),
[`../TESTING.md`](../TESTING.md), [`../RECIPE_FORMAT.md`](../RECIPE_FORMAT.md), and the
project plan in [`../../ROADMAP.md`](../../ROADMAP.md).
