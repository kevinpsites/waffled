# Waffled docs site

The Waffled documentation site — [Astro Starlight](https://starlight.astro.build).
User/operator docs live in `src/content/docs/`; engineering docs stay in the repo's
top-level `docs/`.

## Local

```bash
cd website
npm install
npm run dev      # http://localhost:4321
npm run build    # → ./dist  (static site)
```

## Hosting — Cloudflare Pages

Deployed via **Cloudflare Pages** (free, serves at the root so no base-path fiddling).

**One-time setup** (Cloudflare dashboard → Workers & Pages → Create → **Pages** → Connect to Git):

| Setting | Value |
| --- | --- |
| Repository | this repo |
| Production branch | `main` |
| Framework preset | **Astro** |
| **Root directory** | `website` |
| Build command | `npm run build` |
| Build output directory | `dist` |

That's it — every push to `main` that touches `website/` rebuilds and deploys to a free
`*.pages.dev` URL with HTTPS.

**Custom domain (later):** Pages project → **Custom domains → Set up a domain** → add
e.g. `docs.<yourdomain>` and follow the one DNS record. Free SSL. The site serves at the
root either way, so no config change is needed. (Optionally set a `DOCS_SITE` env var in
Cloudflare to your final URL so the sitemap/canonical links are absolute — purely optional.)

> The old GitHub Actions Pages workflow (`.github/workflows/docs.yml`) was removed in
> favor of Cloudflare Pages, which builds independently of GitHub Actions.
