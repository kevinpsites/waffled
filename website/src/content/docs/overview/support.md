---
title: Support the project
description: Ways to help Waffled — from a GitHub star to code, docs, and spreading the word.
---

Waffled is **free, open source, and self-hosted** — there's no subscription funding its
development. If it's useful to your family, here are the ways to help keep it going. None of
them cost money; all of them matter.

## Star the repo ⭐

The single easiest thing: [star Waffled on GitHub](https://github.com/kevinpsites/waffled).
Stars are how other families find the project and how it earns a place in "self-hosted family
hub" lists. It takes five seconds and genuinely helps.

## Spread the word

- Tell a family that's paying for a calendar-frame subscription there's a self-hosted option.
- Post a screenshot of your kitchen kiosk. Real setups convince people better than a README.
- Mention it in self-hosting communities (r/selfhosted, homelab forums, the Fediverse).
- Write about your setup — a blog post or a comment thread is a durable pointer for the next
  person searching.

## Report bugs and ideas

Found something broken or missing?

- **Bugs & feature requests:** open a [GitHub issue](https://github.com/kevinpsites/waffled/issues).
  Include your version (Settings → System Health), the surface (kiosk / web / iOS), and steps
  to reproduce. `./waffled doctor` output is gold for anything ops-related.
- **Security issues:** please report privately per [`SECURITY.md`](https://github.com/kevinpsites/waffled/blob/main/SECURITY.md)
  — not a public issue.
- **Questions & discussion:** GitHub Issues / Discussions.

Good bug reports are a real contribution — they're often the hardest part of fixing a problem.

## Contribute code or docs

Waffled is [AGPL-3.0](https://github.com/kevinpsites/waffled/blob/main/LICENSE) and built to be
extended. The [Developer](/developer/architecture/) section walks through the architecture,
[local setup](/developer/local-development/), and [how to build a new module](/concepts/extensibility/).

- **Code:** see [`CONTRIBUTING.md`](https://github.com/kevinpsites/waffled/blob/main/CONTRIBUTING.md)
  for setup, the conventional-commit style, and how to run the tests. Keep PRs focused, add a
  test, update the `CHANGELOG.md`.
- **Docs:** the site you're reading is in `website/` (Astro Starlight). Fixing a typo, clarifying
  a step, or documenting a gotcha you hit is a high-value, low-friction contribution.
- **Translations, guides, screenshots** — all welcome.

New features generally ship as **opt-in modules** (off by default), so contributing one doesn't
force it on anyone — see [Extensibility & modules](/concepts/extensibility/).

## Self-host it well

Even just running Waffled and keeping it healthy helps the project mature: real households
surface real edge cases. Two things that pay you back and help everyone:

- **Keep [backups](/operations/backup/) real** (offsite, tested). It's the one piece of ops that's
  entirely on you.
- **Stay current** with `./waffled upgrade` and report anything that breaks on the way — upgrade
  paths only get smooth when people run them.

## The license, briefly

AGPL-3.0 means you can run, read, modify, and share Waffled freely — and if you distribute a
modified version *or run it as a network service for others*, you share your changes under the
same license. It's the license that keeps a self-hosted project open for the next family, too.
