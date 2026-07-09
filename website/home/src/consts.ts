// Shared outbound links for the landing page. Docs live on their own subdomain
// (deployed from ../docs); GitHub is the canonical repo.
export const DOCS = 'https://docs.waffled.app';
export const GITHUB = 'https://github.com/kevinpsites/waffled';

export const LINKS = {
	docs: DOCS,
	quickStart: `${DOCS}/getting-started/quick-start/`,
	overview: `${DOCS}/getting-started/overview/`,
	install: `${DOCS}/install/docker/`,
	requirements: `${DOCS}/install/requirements/`,
	features: `${DOCS}/reference/features/`,
	api: `${DOCS}/reference/api/`,
	comparison: `${DOCS}/overview/comparison/`,
	faq: `${DOCS}/overview/faq/`,
	github: GITHUB,
	issues: `${GITHUB}/issues`,
	contributing: `${DOCS}/developer/contributing/`,
	license: `${GITHUB}/blob/main/LICENSE`,
	security: `${GITHUB}/blob/main/SECURITY.md`,
	changelog: `${GITHUB}/blob/main/CHANGELOG.md`,
} as const;

// Managed-hosting interest form (Google Form). Paste the published form URL here
// and the hosted card's button lights up automatically; while it's empty the
// card just shows a muted "waitlist opening soon" line (no dead link).
export const HOSTED_FORM_URL = 'https://forms.gle/KuNXkooDKzZivwim8';

// Feature cards → each links to its docs feature page.
export const FEATURES = [
	{ icon: '📅', title: 'Calendar & countdowns', slug: 'features/calendar', blurb: 'One shared family calendar with recurring events, Google sync, and “N days until” countdowns.' },
	{ icon: '✅', title: 'Chores & stars', slug: 'features/chores', blurb: 'Assign chores, earn stars, and fund a rewards economy the whole household can see.' },
	{ icon: '🎯', title: 'Goals & Apple Health', slug: 'features/goals', blurb: 'Track personal goals — and let Apple Health steps and workouts move them automatically.' },
	{ icon: '🍽️', title: 'Meals & recipes', slug: 'features/meals', blurb: 'Plan the week, keep recipes with cook-mode timers, and roll ingredients into the grocery list.' },
	{ icon: '🛒', title: 'Lists & groceries', slug: 'features/lists', blurb: 'Shared shopping and to-do lists that stay in sync across the kiosk and every phone.' },
	{ icon: '🥫', title: 'Pantry', slug: 'features/pantry', blurb: 'Scan barcodes, track what’s in stock, get low-stock and expiry nudges with allergen warnings.' },
	{ icon: '🖼️', title: 'Photos & screensaver', slug: 'features/photos', blurb: 'Turn the kitchen display into a family photo frame when no one’s tapping.' },
	{ icon: '🌙', title: 'Family Night', slug: 'features/family-night', blurb: 'A customizable, auto-rotating agenda for your weekly family time.' },
	{ icon: '✨', title: 'AI capture bar', slug: 'features/capture', blurb: 'Type “dentist tuesday 3pm” or “add milk” — AI files it to the right place. Bring your own model.' },
] as const;
