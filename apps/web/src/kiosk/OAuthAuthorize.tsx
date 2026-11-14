// /oauth/authorize — the consent step of an AI app (MCP connector) signing in. AuthGate has
// already shown the ordinary login if needed; this asks which household and what the app
// may do. The server validates the request and builds every redirect, so this screen only
// ever leaves for a URL the api handed back.
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router'
import { oauthApi, type ConsentError, type ConsentInfo } from '../lib/api'
import { AuthShell } from './AuthGate'
import '../styles/auth.css'

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'leaving' }
  | { kind: 'ready'; info: ConsentInfo }

function isConsentError(v: unknown): v is ConsentError {
  return typeof v === 'object' && v !== null && 'error' in v
}

const leaveForUrl = (url: string) => window.location.assign(url)

export function OAuthAuthorize({ onLeave = leaveForUrl }: { onLeave?: (url: string) => void }) {
  const { search } = useLocation()
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search])
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [householdId, setHouseholdId] = useState('')
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    oauthApi
      .consentInfo(search)
      .then((r) => {
        if (!alive) return
        if (isConsentError(r)) {
          if (r.redirect) {
            setState({ kind: 'leaving' })
            onLeave(r.redirect)
          } else setState({ kind: 'error', message: r.description })
          return
        }
        setHouseholdId(r.households.find((h) => h.canConnect)?.id ?? '')
        // Reads on by default; anything that changes data is opt-in.
        setGranted(new Set(r.scopes.filter((s) => !s.write).map((s) => s.scope)))
        setState({ kind: 'ready', info: r })
      })
      .catch(() => alive && setState({ kind: 'error', message: 'Could not load this request. Try again from the app.' }))
    return () => {
      alive = false
    }
  }, [search, onLeave])

  async function answer(decision: 'approve' | 'deny') {
    if (state.kind !== 'ready' || busy) return
    setBusy(true)
    try {
      const r = await oauthApi.decide(
        params,
        decision === 'approve'
          ? { decision, householdId, scopes: state.info.scopes.map((s) => s.scope).filter((s) => granted.has(s)) }
          : { decision }
      )
      if (isConsentError(r)) {
        if (r.redirect) onLeave(r.redirect)
        else setState({ kind: 'error', message: r.description })
        return
      }
      setState({ kind: 'leaving' })
      onLeave(r.redirect)
    } catch (err) {
      const message = (err as { body?: { message?: string } }).body?.message
      setState({ kind: 'error', message: message || 'Could not finish connecting. Try again from the app.' })
    } finally {
      setBusy(false)
    }
  }

  // A framed consent page could be overlaid to trick the Approve click.
  if (window.top !== window.self) {
    return <AuthShell title="Connect an app" sub="For your safety, open this page in its own window to approve it.">{null}</AuthShell>
  }
  if (state.kind === 'loading') return <AuthShell title="Connect an app" sub="Loading…">{null}</AuthShell>
  if (state.kind === 'leaving') return <AuthShell title="Returning to the app" sub="You can close this tab if it doesn’t close itself.">{null}</AuthShell>
  if (state.kind === 'error') {
    return (
      <AuthShell title="This link can’t be used" sub="Start connecting again from the app.">
        <div className="auth-error" role="alert">{state.message}</div>
        <a className="btn btn-ghost auth-submit" href="/">Back to Waffled</a>
      </AuthShell>
    )
  }

  const { info } = state
  const connectable = info.households.filter((h) => h.canConnect)
  if (connectable.length === 0) {
    return (
      <AuthShell title={`Connect ${info.client.name}?`} sub="You can’t connect AI apps to this household.">
        <div className="oauth-note">
          Ask a household admin to turn on <strong>Connect AI apps</strong> for your role in Settings → Family &amp; People → Permissions.
        </div>
        <button type="button" className="btn btn-ghost auth-submit" disabled={busy} onClick={() => answer('deny')}>Cancel</button>
      </AuthShell>
    )
  }

  const toggle = (scope: string) =>
    setGranted((cur) => {
      const next = new Set(cur)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })

  return (
    <AuthShell title={`Connect ${info.client.name}?`} sub={`${info.client.name} wants to use your Waffled as you.`}>
      <div className="oauth-host">
        After you approve, you’ll be sent to <strong>{info.client.redirectHost}</strong>
      </div>

      {connectable.length > 1 && (
        <>
          <label className="auth-label" htmlFor="oauth-household">Household</label>
          <select id="oauth-household" className="auth-input auth-select" value={householdId} onChange={(e) => setHouseholdId(e.target.value)}>
            {connectable.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </>
      )}

      <div className="auth-section" style={{ marginTop: 16 }}>It will be able to</div>
      <div className="oauth-scopes">
        {info.scopes.map((s) => {
          const on = granted.has(s.scope)
          return (
            <div key={s.scope} className="oauth-scope">
              <span className="oauth-scope-t">{s.description}</span>
              <button type="button" role="switch" aria-checked={on} aria-label={s.description} className={`toggle ${on ? 'on' : ''}`} onClick={() => toggle(s.scope)} />
            </div>
          )
        })}
      </div>
      <div className="oauth-note">It can only do what you can do in Waffled. Revoke it any time in Settings → Connected apps.</div>

      <button type="button" className="btn btn-primary auth-submit" disabled={busy || granted.size === 0 || !householdId} onClick={() => answer('approve')}>
        Approve
      </button>
      <button type="button" className="btn btn-ghost auth-submit" style={{ marginTop: 8 }} disabled={busy} onClick={() => answer('deny')}>
        Cancel
      </button>
    </AuthShell>
  )
}
