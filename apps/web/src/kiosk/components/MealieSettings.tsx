// Settings → Mealie. Admins edit the connection; everyone else sees a read-only line.
import { useCallback, useEffect, useState } from 'react'
import { mealieApi, type MealieConnection } from '../../lib/api/mealie'
import { ApiSendError } from '../../lib/api/client'
import { SettingCard } from './SettingCard'

const errMsg = (e: unknown) => (e instanceof ApiSendError && e.body?.message ? String(e.body.message) : "Couldn't save. Try again.")

export function MealieSettings({ isAdmin }: { isAdmin: boolean }) {
  const [conn, setConn] = useState<MealieConnection | null>(null)
  const [lists, setLists] = useState<{ id: string; name: string }[]>([])
  const [baseUrl, setBaseUrl] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const adopt = useCallback((c: MealieConnection) => {
    setConn(c)
    setBaseUrl(c.baseUrl ?? '')
    setPublicUrl(c.publicUrl ?? '')
    setToken('')
  }, [])

  const loadLists = useCallback(() => {
    mealieApi.shoppingLists().then(setLists).catch(() => setLists([]))
  }, [])

  useEffect(() => {
    let alive = true
    mealieApi.connection().then((c) => {
      if (!alive) return
      adopt(c)
      if (c.connected && isAdmin) loadLists()
    }).catch(() => alive && setConn({ connected: false }))
    return () => { alive = false }
  }, [adopt, isAdmin, loadLists])

  async function run(fn: () => Promise<MealieConnection | void>, after?: (c: MealieConnection) => void) {
    setBusy(true)
    setErr(null)
    try {
      const c = await fn()
      if (c) { adopt(c); after?.(c) }
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const save = () => run(() => {
    const pub = publicUrl.trim()
    return mealieApi.saveConnection({
      baseUrl: baseUrl.trim(),
      ...(pub || conn?.publicUrl ? { publicUrl: pub } : {}),
      ...(token.trim() ? { token: token.trim() } : {}),
    })
  }, loadLists)

  const pickList = (id: string) => run(() => mealieApi.saveConnection({ baseUrl: conn?.baseUrl ?? baseUrl.trim(), shoppingListId: id }))

  const disconnect = () => {
    if (!window.confirm('Disconnect Mealie? Waffled goes back to its built-in meals and groceries.')) return
    run(async () => { await mealieApi.disconnect(); setLists([]); adopt({ connected: false }) })
  }

  const connected = !!conn?.connected

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Mealie</div>
        <div className="set-head-sub">Use your Mealie server for recipes, the meal plan and the shopping list.</div>
      </div>
      {conn === null ? (
        <div className="muted" style={{ padding: 20 }}>Loading…</div>
      ) : !isAdmin ? (
        <SettingCard>
          <div style={{ fontWeight: 700 }}>{connected ? `Connected to Mealie${conn.shoppingListName ? ` · ${conn.shoppingListName}` : ''}` : 'Mealie is not connected. An admin can set it up.'}</div>
        </SettingCard>
      ) : (
        <SettingCard>
          <label className="field">
            <span>Mealie URL</span>
            <input aria-label="Mealie URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://mealie:9000" />
          </label>
          <label className="field">
            <span>Public URL (optional)</span>
            <input aria-label="Public URL (optional)" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://food.example.com" />
          </label>
          <label className="field">
            <span>API token</span>
            <input aria-label="API token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={connected ? '••• saved' : 'Paste a Mealie API token'} />
          </label>
          {connected && lists.length > 0 && (
            <label className="field">
              <span>Shopping list</span>
              <select aria-label="Shopping list" className="sel" value={conn.shoppingListId ?? ''} disabled={busy} onChange={(e) => pickList(e.target.value)}>
                <option value="">Choose a list…</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !baseUrl.trim()}>{connected ? 'Save' : 'Connect'}</button>
            {connected && <button type="button" className="btn btn-ghost" onClick={disconnect} disabled={busy}>Disconnect</button>}
          </div>
          {err && <div className="tiny" role="alert" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{err}</div>}
        </SettingCard>
      )}
    </div>
  )
}
