// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	// GitHub-Pages-friendly: `site` + `base` read from env so this works at the
	// root locally (defaults) and under a project subpath when deployed.
	site: process.env.DOCS_SITE || undefined,
	base: process.env.DOCS_BASE || '/',
	integrations: [
		starlight({
			title: 'Kinnook',
			tagline: 'Self-hosted family hub',
			logo: { src: './src/assets/kinnook-logo.png', alt: 'Kinnook' },
			favicon: '/favicon.png',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kevinpsites/nook' }],
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'Overview', slug: 'getting-started/overview' },
						{ label: 'Quick start', slug: 'getting-started/quick-start' },
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
