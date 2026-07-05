import { Icon, type IconName } from '../icons'

// A clean stand-in for screens whose backend domain doesn't exist yet, so the
// rail always navigates somewhere instead of dead-clicking.
export function Placeholder({ title, icon }: { title: string; icon: IconName }) {
  return (
    <div className="screen-placeholder">
      <div className="ph-icon">
        <Icon name={icon} />
      </div>
      <div className="wf-serif ph-title">{title}</div>
      <div className="muted">Coming soon — this screen lights up as its backend lands.</div>
    </div>
  )
}
