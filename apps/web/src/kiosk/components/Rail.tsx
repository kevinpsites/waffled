import { NavLink, Link } from 'react-router'
import { Icon } from '../icons'
import { SCREENS, SETTINGS, type Screen } from '../nav'
import { useState } from 'react'
import { isKioskMode, authApi, PrincipalTransitionError, useHousehold } from '../../lib/api'
import { moduleEnabled } from '../../lib/modules'

function railClass({ isActive }: { isActive: boolean }) {
  return `rail-item ${isActive ? 'on' : ''}`
}

// Bottom-of-rail account chip: always shows who's signed in. In kiosk mode it's a
// one-tap return to the profile picker ("Switch"); otherwise it shows the person's
// name and links to Settings (account).
function RailAccount({ onNavigate }: { onNavigate?: () => void }) {
  const { person } = useHousehold()
  const [recovery, setRecovery] = useState<'none' | 'discard' | 'quarantine'>('none')
  const [busy, setBusy] = useState(false)
  const avatar = (
    <span
      className="rail-switch-av"
      style={{ background: person?.colorHex ? `${person.colorHex}22` : 'var(--panel)' }}
    >
      {person?.avatarEmoji ?? '🙂'}
    </span>
  )

  if (isKioskMode()) {
    const switchProfile = async () => {
      setBusy(true)
      try {
        await authApi.logout({ discardPending: recovery !== 'none' })
        onNavigate?.()
      } catch (err) {
        if (err instanceof PrincipalTransitionError && err.result === 'pending-uploads') {
          setRecovery('discard')
        } else if (err instanceof PrincipalTransitionError && err.result === 'purge-failed') {
          setRecovery('quarantine')
        }
        setBusy(false)
      }
    }
    return (
      <button
        className="rail-switch"
        onClick={() => void switchProfile()}
        disabled={busy}
        title={recovery === 'quarantine'
          ? 'Switch profile and keep unreadable local data locked for cleanup'
          : recovery === 'discard'
            ? 'Discard unsynced changes and switch profile'
            : 'Switch profile'}
      >
        {avatar}
        <span className="rail-switch-label">{busy
          ? 'Switching…'
          : recovery === 'quarantine'
            ? 'Lock data & switch'
            : recovery === 'discard'
              ? 'Discard & switch'
              : 'Switch'}</span>
      </button>
    )
  }

  if (!person) return null
  const firstName = person.name?.split(' ')[0] || person.name
  return (
    <Link to="/settings" className="rail-switch" title={`Signed in as ${person.name}`} onClick={onNavigate}>
      {avatar}
      <span className="rail-switch-label">{firstName}</span>
    </Link>
  )
}

function RailLink({ screen, onNavigate }: { screen: Screen; onNavigate?: () => void }) {
  return (
    <NavLink to={screen.path} end={screen.path === '/'} className={railClass} onClick={onNavigate}>
      <Icon name={screen.icon} />
      {screen.label}
    </NavLink>
  )
}

export function Rail({ mobileOpen = false, onNavigate }: { mobileOpen?: boolean; onNavigate?: () => void }) {
  const { household } = useHousehold()
  // Hide nav entries for optional modules the household hasn't enabled.
  const screens = SCREENS.filter((s) => !s.module || moduleEnabled(household, s.module))
  return (
    <nav id="primary-navigation" className={`rail${mobileOpen ? ' mobile-open' : ''}`} aria-label="Primary navigation">
      <Link to="/" className="rail-logo" aria-label="Home" onClick={onNavigate}><img src="/logo.png" alt="Waffled" /></Link>
      {screens.map((s) => (
        <RailLink key={s.path} screen={s} onNavigate={onNavigate} />
      ))}
      <div className="rail-spacer" />
      <RailAccount onNavigate={onNavigate} />
      <RailLink screen={SETTINGS} onNavigate={onNavigate} />
    </nav>
  )
}
