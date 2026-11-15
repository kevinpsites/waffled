// Settings → Connected apps: the AI apps (MCP connectors) this account approved, and a
// revoke for each. Revoking ends the connection on the app's next request.
import { useEffect, useState } from 'react'
import { oauthApi, type ConnectedApp } from '../../lib/api'
import { ConfirmDialog } from './ConfirmDialog'

export function ConnectedAppsPanel() {
  const [grants, setGrants] = useState<ConnectedApp[] | null>(null)
  const [describe, setDescribe] = useState<Record<string, string>>({})
  const [revoking, setRevoking] = useState<ConnectedApp | null>(null)

  const refetch = () =>
    oauthApi
      .listGrants()
      .then((r) => {
        setGrants(r.grants)
        setDescribe(r.scopeDescriptions)
      })
      .catch(() => setGrants([]))
  useEffect(() => {
    refetch()
  }, [])

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Connected apps</div>
      </div>
      <div className="tiny muted" style={{ fontWeight: 600, margin: '-6px 2px 16px', lineHeight: 1.45 }}>
        AI apps you signed in to Waffled with, such as Claude. Each one acts as you — it can only
        do what your account can, limited further to what you approved. Revoke one to disconnect it.
      </div>

      {grants == null ? (
        <div className="tiny muted" style={{ fontWeight: 600, padding: 8 }}>Loading…</div>
      ) : grants.length === 0 ? (
        <div className="tiny muted" style={{ fontWeight: 600, padding: '14px 2px' }}>No apps are connected. Add Waffled as a connector in Claude to see it here.</div>
      ) : (
        <div className="apikey-list">
          {grants.map((g) => (
            <div key={g.id} className="apikey-row">
              <div className="apikey-main">
                <div className="apikey-name">{g.clientName}</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>Returns to {g.redirectHost} · {g.householdName}</div>
                <div className="apikey-scopes">
                  {g.scopes.map((s) => <span key={s} className="apikey-scope">{describe[s] ?? s}</span>)}
                </div>
                <div className="tiny muted apikey-meta">
                  {g.lastUsedAt ? `Last used ${new Date(g.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  {' · '}Connected {new Date(g.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button type="button" className="btn btn-ghost apikey-revoke" onClick={() => setRevoking(g)}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Disconnect “${revoking.clientName}”?`}
          message="It will lose access on its next request. Connecting it again means signing in again."
          confirmLabel="Revoke"
          danger
          onConfirm={async () => {
            await oauthApi.revokeGrant(revoking.id)
            setRevoking(null)
            await refetch()
          }}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  )
}
