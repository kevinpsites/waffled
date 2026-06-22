import { NavLink, Link } from 'react-router'
import { Icon } from '../icons'
import { SCREENS, SETTINGS, type Screen } from '../nav'
import { isKioskMode, authApi, useHousehold } from '../../lib/api'

function railClass({ isActive }: { isActive: boolean }) {
  return `rail-item ${isActive ? 'on' : ''}`
}

// In kiosk mode: show who's acting + a one-tap return to the profile picker.
function KioskSwitch() {
  const { person } = useHousehold()
  if (!isKioskMode()) return null
  return (
    <button className="rail-switch" onClick={() => void authApi.logout()} title="Switch profile">
      <span
        className="rail-switch-av"
        style={{ background: person?.colorHex ? `${person.colorHex}22` : 'var(--panel)' }}
      >
        {person?.avatarEmoji ?? '🙂'}
      </span>
      <span className="rail-switch-label">Switch</span>
    </button>
  )
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
      <KioskSwitch />
    </nav>
  )
}
