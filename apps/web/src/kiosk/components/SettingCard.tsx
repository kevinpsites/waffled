import type { ReactNode, CSSProperties } from 'react'

// The one settings card box. Prefer this over a hand-rolled
// `<div className="set-card">` so padding stays centralized in .set-card (20px,
// uniform on all four sides). Shared by Settings.tsx and PersonModal.tsx.
export function SettingCard({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`set-card${className ? ` ${className}` : ''}`} style={style}>{children}</div>
}
