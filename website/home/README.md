# Waffled home (marketing landing)

The public landing page for **waffled.app** — a plain, static [Astro](https://astro.build)
site (no Starlight, no framework integrations). It funnels visitors to the docs
(`docs.waffled.app`) and GitHub. The docs site lives in the sibling
[`../docs`](../docs) project and deploys separately.

## Local

```bash
cd website/home
npm install
npm run dev      # http://localhost:4321
npm run build    # → ./dist  (static site)
npm run preview  # serve the built ./dist
```

## Structure

```
src/
  consts.ts            outbound links (docs subdomain, GitHub) + feature list
  layouts/Base.astro   <head>, fonts, Nav + Footer shell, OG/canonical meta
  components/Nav.astro  sticky top nav (+ mobile menu, scroll shadow)
  components/Footer.astro
  pages/index.astro    the landing sections
  styles/home.css      brand tokens + all landing styles
public/                favicon + logo/icon (copied from the app brand)
```

## Editing content

- **Links** (docs URLs, GitHub) live in `src/consts.ts` — change them in one place.
- **Feature cards** are the `FEATURES` array in `src/consts.ts`.
- **Brand tokens** (colours, fonts) are the CSS variables at the top of
  `src/styles/home.css`, mirrored from the app (`apps/web/src/styles/waffled.css`)
  and docs (`../docs/src/styles/docs.css`) so the three surfaces never drift.

## Screenshots (TODO)

The hero and "three surfaces" section currently use **CSS placeholder mockups**
(the `.device` / `.surface .art` blocks). Swap each for a real `<img>` once we
have product screenshots — capture the kiosk via Playwright and the iOS app via
the simulator. The mockups are self-contained so replacing them is a local edit.

## Hosting

Deployed via **Cloudflare Pages** as its own project (root directory
`website/home`), independent of the docs site. See [`../README.md`](../README.md)
for the two-project / build-watch-path setup.
