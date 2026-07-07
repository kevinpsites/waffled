// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	// GitHub-Pages-friendly: `site` + `base` read from env so this works at the
	// root locally (defaults) and under a project subpath when deployed.
	site: process.env.DOCS_SITE || 'https://waffled.app',
	base: process.env.DOCS_BASE || '/',
	integrations: [
		starlight({
			title: 'Waffled',
			tagline: 'Self-hosted family hub',
			logo: { src: './src/assets/waffled-logo.png', alt: 'Waffled' },
			favicon: '/favicon.png',
			customCss: ['./src/styles/docs.css'],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kevinpsites/waffled' }],
			sidebar: [
				{
					label: 'Overview',
					items: [
						{ label: 'Introduction', slug: 'getting-started/overview' },
						{ label: 'Quick start', slug: 'getting-started/quick-start' },
						{ label: 'Comparison', slug: 'overview/comparison' },
						{ label: 'Support the project', slug: 'overview/support' },
						{ label: 'FAQ', slug: 'overview/faq' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Feature matrix', slug: 'reference/features' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'Permissions', slug: 'concepts/permissions' },
						{ label: 'Extensibility & modules', slug: 'concepts/extensibility' },
					],
				},
				{
					label: 'Operations',
					items: [
						{ label: 'Backup & restore', slug: 'operations/backup' },
						{ label: 'Upgrading', slug: 'operations/upgrading' },
						{ label: 'Troubleshooting', slug: 'operations/troubleshooting' },
					],
				},
			],
		}),
	],
});
