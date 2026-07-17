// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	// GitHub-Pages-friendly: `site` + `base` read from env so this works at the
	// root locally (defaults) and under a project subpath when deployed.
	site: process.env.DOCS_SITE || 'https://docs.waffled.app',
	base: process.env.DOCS_BASE || '/',
	integrations: [
		starlight({
			title: 'Waffled',
			tagline: 'Self-hosted family hub',
			logo: { src: './src/assets/waffled-logo.png', alt: 'Waffled' },
			favicon: '/favicon.png',
			customCss: ['./src/styles/docs.css'],
			// Custom hero: adds the official App Store badge to the homepage action row.
			components: { Hero: './src/components/Hero.astro' },
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
					label: 'Install',
					items: [
						{ label: 'Requirements', slug: 'install/requirements' },
						{ label: 'Docker install', slug: 'install/docker' },
						{ label: 'Environment variables', slug: 'install/environment-variables' },
						{ label: 'Reverse proxy & TLS', slug: 'install/reverse-proxy' },
						{ label: 'Upgrading', slug: 'operations/upgrading' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Feature matrix', slug: 'reference/features' },
						{ label: 'Calendar & events', slug: 'features/calendar' },
						{ label: 'Countdowns', slug: 'features/countdowns' },
						{ label: 'Today dashboard', slug: 'features/today' },
						{ label: 'Chores & tasks', slug: 'features/chores' },
						{ label: 'Rewards & economy', slug: 'features/rewards' },
						{ label: 'Goals', slug: 'features/goals' },
						{ label: 'Apple Health → goals', slug: 'features/apple-health' },
						{ label: 'Meals & recipes', slug: 'features/meals' },
						{ label: 'Lists & groceries', slug: 'features/lists' },
						{ label: 'Pantry', slug: 'features/pantry' },
						{ label: 'Photos & screensaver', slug: 'features/photos' },
						{ label: 'Family Night', slug: 'features/family-night' },
						{ label: 'AI capture bar', slug: 'features/capture' },
						{ label: 'Kiosk & display', slug: 'features/kiosk' },
						{ label: 'Appearance & dark mode', slug: 'features/appearance' },
						{ label: 'Mobile app (iOS)', slug: 'features/mobile' },
					],
				},
				{
					label: 'Administration',
					items: [
						{ label: 'Users & members', slug: 'administration/users' },
						{ label: 'Permissions & roles', slug: 'concepts/permissions' },
						{ label: 'Modules', slug: 'administration/modules' },
						{ label: 'Authentication & SSO', slug: 'administration/authentication' },
						{ label: 'Google Calendar', slug: 'administration/google-calendar' },
						{ label: 'AI providers', slug: 'administration/ai-providers' },
						{ label: 'Kiosk & devices', slug: 'administration/kiosk' },
						{ label: 'System health', slug: 'administration/system-health' },
						{ label: 'Backup & restore', slug: 'operations/backup' },
						{ label: 'Troubleshooting', slug: 'operations/troubleshooting' },
					],
				},
				{
					label: 'Developer',
					items: [
						{ label: 'Architecture', slug: 'developer/architecture' },
						{ label: 'Local development', slug: 'developer/local-development' },
						{ label: 'Database & migrations', slug: 'developer/database' },
						{ label: 'Building a module', slug: 'concepts/extensibility' },
						{ label: 'iOS development', slug: 'developer/ios' },
						{ label: 'Contributing', slug: 'developer/contributing' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Set up a kitchen kiosk', slug: 'guides/kitchen-kiosk' },
						{ label: 'Add a recipe from a photo or voice', slug: 'guides/ai-recipe-import' },
						{ label: 'Run AI locally with Ollama', slug: 'guides/local-ai' },
						{ label: 'Offsite backups (3-2-1)', slug: 'guides/offsite-backups' },
						{ label: 'Deploy to Oracle Cloud (free)', slug: 'guides/oracle-cloud-terraform' },
						{ label: 'Move to new hardware', slug: 'guides/moving-hardware' },
					],
				},
				{ label: 'API reference', slug: 'reference/api' },
			],
		}),
	],
});
