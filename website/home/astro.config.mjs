// @ts-check
import { defineConfig } from 'astro/config';

// The Waffled marketing landing page (waffled.app). A plain, static Astro site —
// no Starlight, no framework integrations. Docs live in the sibling `../docs`
// project and deploy separately to docs.waffled.app.
//
// `site` drives absolute canonical/OG/sitemap URLs; override with HOME_SITE in
// Cloudflare if the production hostname ever changes.
export default defineConfig({
	site: process.env.HOME_SITE || 'https://waffled.app',
});
