import { useCallback, useEffect, useState, type ReactNode, type FormEvent } from 'react'
import { authApi, getAccessToken, type SetupInput } from '../lib/api'
import '../styles/auth.css'

type Phase = 'loading' | 'authed' | 'login' | 'setup'

// Gates the whole kiosk: shows the first-run Setup wizard, the Login screen, or the
// app — driven by whether a session exists and whether the instance is initialized.
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (getAccessToken() ? 'authed' : 'loading'))

  const resolve = useCallback(async () => {
    if (getAccessToken()) {
      setPhase('authed')
      return
    }
    try {
      const s = await authApi.status()
      setPhase(s.initialized ? 'login' : 'setup')
    } catch {
      setPhase('login')
    }
  }, [])

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
  if (phase === 'login') return <LoginScreen />
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
        <div className="auth-logo nk-serif">N</div>
        <div className="auth-title nk-serif">{title}</div>
        <div className="auth-sub">{sub}</div>
        {children}
      </div>
    </div>
  )
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <AuthShell title="Welcome back" sub="Sign in to your family's Nook.">
      <form onSubmit={submit} className="auth-form">
        <label className="auth-label">Email</label>
        <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  )
}

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

  const passwordsMatch = password === confirm
  const valid = householdName.trim() && timezone.trim() && name.trim() && email.trim() && password.length >= 8 && passwordsMatch

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    const input: SetupInput = {
      household: { name: householdName.trim(), timezone: timezone.trim() },
      admin: { name: name.trim(), email: email.trim(), password },
    }
    try {
      await authApi.setup(input)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Welcome to Nook" sub="Let's set up your household and your admin account.">
      <form onSubmit={submit} className="auth-form">
        <div className="auth-section">Your household</div>
        <label className="auth-label">Household name</label>
        <input className="auth-input" value={householdName} onChange={(e) => setHouseholdName(e.target.value)} placeholder="The Sites Family" autoFocus required />
        <label className="auth-label">Timezone</label>
        <input className="auth-input" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" required />

        <div className="auth-section" style={{ marginTop: 14 }}>Admin account</div>
        <label className="auth-label">Your name</label>
        <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kevin" required />
        <label className="auth-label">Email</label>
        <input className="auth-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="auth-label">Password</label>
        <input className="auth-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required />
        <label className="auth-label">Confirm password</label>
        <input className="auth-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {password && confirm && !passwordsMatch && <div className="auth-error">Passwords don't match.</div>}
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !valid}>
          {busy ? 'Creating…' : 'Create household'}
        </button>
      </form>
    </AuthShell>
  )
}
