import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons'

// The kiosk's centred full-screen state: an optional icon, a title, and a body.
// Used for screens whose backend domain doesn't exist yet — so the rail always
// navigates somewhere instead of dead-clicking — and for the error state a screen
// falls back to when its chunk never arrives (see ScreenBoundary). Passing
// `children` replaces the default "coming soon" line, which is only right for the
// first of those.
export function Placeholder({
  title,
  icon,
  children,
}: {
  title: string
  icon?: IconName
  children?: ReactNode
}) {
  return (
    <div className="screen-placeholder">
      {icon && (
        <div className="ph-icon">
          <Icon name={icon} />
        </div>
      )}
      <div className="wf-serif ph-title">{title}</div>
      {children ?? <div className="muted">Coming soon — this screen lights up as its backend lands.</div>}
    </div>
  )
}
