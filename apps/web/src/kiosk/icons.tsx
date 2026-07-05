// SVG icon paths ported verbatim from the design (screens-kiosk-home.js `ic`).
// waffled.css styles the stroke/fill per context (rail, pill, etc.), so each icon
// is just the inner markup inside a 0 0 24 24 viewBox.
const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M7.5 12l3 3 6-6.5"/>',
  meals: '<path d="M5 3v6a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 3c-1.6 0-2.8 2.2-2.8 5s1 4 2.8 4.2V21"/>',
  recipes:
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19"/>',
  lists:
    '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3"/><circle cx="4.5" cy="12" r="1.3"/><circle cx="4.5" cy="18" r="1.3"/>',
  photos: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8"/>',
  goals: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r=".9"/>',
  cloud: '<path d="M7 18h9.5a3.8 3.8 0 0 0 .3-7.6 5.2 5.2 0 0 0-9.9-1.2A3.6 3.6 0 0 0 7 18z"/>',
  spark: '<path d="M12 2.5l1.7 5.2 5.3 1.6-5.3 1.6L12 16l-1.7-5.1-5.3-1.6 5.3-1.6z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cr: '<path d="M9 6l6 6-6 6"/>',
  cl: '<path d="M15 6l-6 6 6 6"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
  bag: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  family: '<circle cx="8" cy="8" r="3"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="8.5" r="2.4"/><path d="M14.8 20a4.6 4.6 0 0 1 6.7-4.1"/>',
  pantry: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M12 3v18"/>',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
}

// The star glyph (filled), used for stars/rewards counts.
export function Star({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ fill: 'currentColor' }}>
      <path d="M12 3l2.5 5.6 6.1.7-4.5 4.1 1.2 6L12 16.6 6.7 19.4l1.2-6-4.5-4.1 6.1-.7z" />
    </svg>
  )
}

export function Check({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
      <path d="M5 12.5l4.5 4.5L19 6.5" />
    </svg>
  )
}
