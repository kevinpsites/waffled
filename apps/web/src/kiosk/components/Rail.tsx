import { NavLink, Link } from 'react-router'
import { Icon } from '../icons'
import { SCREENS, SETTINGS, type Screen } from '../nav'

function railClass({ isActive }: { isActive: boolean }) {
  return `rail-item ${isActive ? 'on' : ''}`
}

function RailLink({ screen }: { screen: Screen }) {
  return (
    <NavLink to={screen.path} end={screen.path === '/'} className={railClass}>
      <Icon name={screen.icon} />
      {screen.label}
    </NavLink>
  )
}

export function Rail() {
  return (
    <nav className="rail">
      <Link to="/" className="rail-logo nk-serif" aria-label="Home">N</Link>
      <div className="rail-new">New</div>
      {SCREENS.map((s) => (
        <RailLink key={s.path} screen={s} />
      ))}
      <div className="rail-spacer" />
      <RailLink screen={SETTINGS} />
    </nav>
  )
}
