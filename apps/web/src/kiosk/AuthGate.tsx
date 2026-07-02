import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { authApi, getAccessToken, isKioskMode, type AuthStatus, type SetupInput } from '../lib/api'
import { ProfilePicker } from './ProfilePicker'
import { PairDevice } from './PairDevice'
import '../styles/auth.css'

type Phase = 'loading' | 'authed' | 'login' | 'setup' | 'picker'

// Gates the whole kiosk: shows the first-run Setup wizard, the Login screen, or the
// app — driven by whether a session exists and whether the instance is initialized.
// Also handles the OIDC return at /auth/callback (exchange the handoff → session).
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (getAccessToken() ? 'authed' : 'loading'))
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [oidcError, setOidcError] = useState<string | null>(null)
  const navigate = useNavigate()
  // The OIDC handoff is single-use; guard against the exchange firing twice (React
  // StrictMode runs effects twice in dev), which would 401 the 2nd call and leave a
  // stale "Invalid or expired sign-in" error that later surfaces on the login screen.
  const exchangingRef = useRef(false)

  const resolve = useCallback(async () => {
    // OIDC return: exchange the one-time handoff code for a session, then clean the URL.
    // Navigate via the router (not history.replaceState) so React Router actually
    // leaves /auth/callback — otherwise the app mounts with no matching route (blank).
    if (window.location.pathname === '/auth/callback') {
      if (exchangingRef.current) return
      exchangingRef.current = true
      const code = new URLSearchParams(window.location.search).get('code')
      try {
        if (!code) throw new Error('Sign-in was cancelled.')
        await authApi.oidcExchange(code) // fires nook:auth-changed on success
        navigate('/', { replace: true })
        return
      } catch (err) {
        setOidcError((err as Error).message)
        navigate('/', { replace: true })
        // fall through to render the login screen with the error
      }
    } else {
      // Any normal (re)resolve — e.g. after signing out — clears a stale OIDC error
      // so it never shows up on a login screen the user reached some other way.
      setOidcError(null)
    }
    if (getAccessToken()) {
      setPhase('authed')
      return
    }
    // Paired kiosk with no active profile → the profile picker (not the login form).
    if (isKioskMode()) {
      setPhase('picker')
      return
    }
    try {
      const s = await authApi.status()
      setStatus(s)
      setPhase(s.initialized ? 'login' : 'setup')
    } catch {
      setPhase('login')
    }
  }, [navigate])

  useEffect(() => {
    if (phase === 'loading') void resolve()
  }, [phase, resolve])

  // Login/setup/logout (and a failed refresh) all fire this; re-resolve.
  useEffect(() => {
    const onChange = () => setPhase(getAccessToken() ? 'authed' : 'loading')
    window.addEventListener('nook:auth-changed', onChange)
    return () => window.removeEventListener('nook:auth-changed', onChange)
  }, [])

  if (phase === 'authed') return <>{children}</>
  if (phase === 'setup') return <SetupWizard />
  if (phase === 'picker') return <ProfilePicker />
  if (phase === 'login') return <LoginScreen status={status} oidcError={oidcError} />
  return (
    <div className="auth-screen">
      <div className="auth-loading">Loading…</div>
    </div>
  )
}

function AuthShell({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo-img" src="/logo.png" alt="Kinnook" width={96} height={96} />
        <div className="auth-title nk-serif">{title}</div>
        <div className="auth-sub">{sub}</div>
        {children}
      </div>
    </div>
  )
}

function LoginScreen({ status, oidcError }: { status: AuthStatus | null; oidcError: string | null }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(oidcError)
  const [pairing, setPairing] = useState(false)

  if (pairing) return <PairDevice onCancel={() => setPairing(false)} />

  // Default to showing the password form until status loads (so we never strand a
  // user on a blank screen); hide it only when the server says it's disabled.
  const showPassword = !status || status.methods.includes('password')
  const showOidc = !!status?.oidc && status.methods.includes('oidc')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await authApi.login(email.trim(), password)
      // setSession fires 'nook:auth-changed' → gate flips to the app.
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Welcome back" sub="Sign in to your family's Kinnook.">
      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
      {showOidc && (
        <button type="button" className="btn auth-submit auth-sso" style={{ marginTop: 0 }} onClick={() => authApi.startOidc()}>
          {status!.oidc!.buttonLabel}
        </button>
      )}
      {showOidc && showPassword && <div className="auth-or">or</div>}
      {showPassword && (
        <form onSubmit={submit} className="auth-form">
          <label className="auth-label">Email</label>
          <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          <label className="auth-label">Password</label>
          <input className="auth-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
      <button type="button" className="auth-kiosk-link" onClick={() => setPairing(true)}>
        Set up this device as a kiosk
      </button>
    </AuthShell>
  )
}

// Full IANA timezone list for the setup dropdown when the runtime exposes it (all
// current browsers do); otherwise a curated North-America-first fallback so the
// field is never just a free-text guess ("what do I put for Seattle?").
const TIMEZONES: string[] = (() => {
  try {
    const all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
    if (Array.isArray(all) && all.length) return all
  } catch {
    /* Intl.supportedValuesOf unsupported — fall through to the curated list */
  }
  return [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto',
    'America/Vancouver', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Asia/Tokyo', 'Australia/Sydney', 'UTC',
  ]
})()

// Login part of 2+ chars, an @, then a dotted domain — "an accurate email".
const SETUP_EMAIL_RE = /^[^\s@]{2,}@[^\s@]+\.[^\s@]+$/

function SetupWizard() {
  const detectedTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'
    } catch {
      return 'America/New_York'
    }
  })()
  const [householdName, setHouseholdName] = useState('')
  const [timezone, setTimezone] = useState(detectedTz)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only surface a field's validation hint when the user leaves it still-invalid —
  // and hide it again the moment they resume typing. Never yell mid-keystroke.
  const [showErr, setShowErr] = useState<{ email?: boolean; password?: boolean; confirm?: boolean }>({})
  const clearErr = (f: 'email' | 'password' | 'confirm') => setShowErr((s) => (s[f] ? { ...s, [f]: false } : s))

  // Pre-select the detected zone; make sure it's selectable even if the fallback list omits it.
  const tzOptions = TIMEZONES.includes(detectedTz) ? TIMEZONES : [detectedTz, ...TIMEZONES]
  const emailValid = SETUP_EMAIL_RE.test(email.trim())
  const passwordLongEnough = password.length >= 8
  const passwordsMatch = password === confirm
  const valid = !!(householdName.trim() && timezone.trim() && name.trim() && emailValid && passwordLongEnough && passwordsMatch)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    const input: SetupInput = {
      household: { name: householdName.trim(), timezone: timezone.trim() },
      // Give the owner a default avatar + color (matching PersonModal's defaults) so
      // they aren't an avatar-less member in pickers/dropdowns; editable later.
      admin: { name: name.trim(), email: email.trim(), password, avatarEmoji: '🙂', colorHex: '#2F7FED' },
    }
    try {
      await authApi.setup(input)
      // The post-setup "Getting started" onboarding is armed server-side at provision
      // time (households.settings.onboarding), so there's nothing to flip here.
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Welcome to Kinnook" sub="Let's set up your household and your admin account.">
      <form onSubmit={submit} className="auth-form">
        <div className="auth-section">Your household</div>
        <label className="auth-label">Household name</label>
        <input className="auth-input" value={householdName} onChange={(e) => setHouseholdName(e.target.value)} placeholder="The Sites Family" autoFocus required />
        <label className="auth-label">Timezone</label>
        <select className="auth-input auth-select" value={timezone} onChange={(e) => setTimezone(e.target.value)} required>
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
          ))}
        </select>

        <div className="auth-section" style={{ marginTop: 14 }}>Admin account</div>
        <label className="auth-label">Your name</label>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Doe" required />
        <label className="auth-label">Email</label>
        <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => { setEmail(e.target.value); clearErr('email') }} onBlur={() => setShowErr((s) => ({ ...s, email: !!email.trim() && !emailValid }))} placeholder="you@example.com" required />
        {showErr.email && <div className="auth-error">Enter a valid email address (e.g. you@example.com).</div>}
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); clearErr('password') }} onBlur={() => setShowErr((s) => ({ ...s, password: !!password && !passwordLongEnough }))} placeholder="At least 8 characters" required />
        {showErr.password && <div className="auth-error">Password must be at least 8 characters.</div>}
        <label className="auth-label">Confirm password</label>
        <input className="auth-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => { setConfirm(e.target.value); clearErr('confirm') }} onBlur={() => setShowErr((s) => ({ ...s, confirm: !!password && !!confirm && !passwordsMatch }))} required />
        {showErr.confirm && <div className="auth-error">Passwords don't match.</div>}
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !valid}>
          {busy ? 'Creating…' : 'Create household'}
        </button>
      </form>
    </AuthShell>
  )
}
