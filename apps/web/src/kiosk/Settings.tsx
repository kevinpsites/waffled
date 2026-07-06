import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { personsApi, permissionsApi, healthApi, updatesApi, type UpdateInfo, accountApi, type AccountInfo, apiKeysApi, captureApi, calendarsApi, mealsApi, currenciesApi, conversionsApi, rewardsApi, choresApi, goalCalendarApi, groceryApi, authApi, kioskApi, usePantry, pantryApi, useCountdowns, countdownsApi, DEFAULT_BIRTHDAY_HORIZON_DAYS, useFamilyNight, familyNightApi, weekdayName, type FamilyNightPart, ALLERGEN_LABELS, ALLERGEN_KEYS, isDisplayMode, setDisplayMode, isKioskMode, usePersons, useCurrencies, useConversions, useHousehold, useHouseholdSettings, useWeather, useEventsToday, usePhotos, emitHouseholdChanged, CAPABILITIES, CAPABILITY_LABELS, ROLE_LABELS, type SettingsMember, type CaptureConfig, type Provider, type CalendarStatus, type CalendarLink, type MealCalendarSettings, type Currency, type MemoryGroup, type PantryStaple, type OidcConfig, type OidcConfigPatch, type KioskDevice, type DisplayConfig, type StoredProof, type PermissionMatrix, type Role, type Capability, type HealthReport, type HealthStatus, type ApiKey, type ApiScopeDef } from '../lib/api'
import { MODULES, moduleEnabled } from '../lib/modules'
import { PersonModal } from './components/PersonModal'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Screensaver, screensaverPhotos } from './components/Screensaver'
import '../styles/settings.css'

// `admin` tabs are only shown to admins — non-admins can't change those settings,
// so we don't show options they can't use (they still get About + Sign out).
// Grouped into three tiers: Account (you) · Family (shared config an admin sets) ·
// System (the self-host/deployment). Order = who you are → the features you use →
// account/operator. Account is thin today; it grows with per-member self-service later.
const NAV = [
  // Account — you
  { key: 'profile', icon: '🙂', label: 'My Profile', group: 'account' },
  { key: 'account', icon: '🔒', label: 'My Account', group: 'account' },
  { key: 'households', icon: '🏠', label: 'Households', group: 'account' },
  // Family — shared household configuration (admin)
  { key: 'family', icon: '👨‍👩‍👧‍👦', label: 'Family & People', admin: true, group: 'family' },
  { key: 'calendars', icon: '📅', label: 'Calendars', admin: true, group: 'family' },
  { key: 'chores', icon: '⭐', label: 'Chores & Rewards', admin: true, group: 'family' },
  { key: 'meals', icon: '🍽️', label: 'Meals', admin: true, group: 'family' },
  { key: 'lists', icon: '📝', label: 'Lists', admin: true, group: 'family' },
  { key: 'modules', icon: '🧩', label: 'Modules', admin: true, group: 'family' },
  { key: 'display', icon: '🖥️', label: 'Display & Kiosk', admin: true, group: 'family' },
  { key: 'notifications', icon: '🔔', label: 'Notifications', admin: true, group: 'family' },
  // System — the self-hosted deployment (admin/operator)
  { key: 'security', icon: '🔐', label: 'Sign-in & Security', admin: true, group: 'system' },
  { key: 'ai', icon: '✨', label: 'AI & Capture', admin: true, group: 'system' },
  { key: 'apikeys', icon: '🔑', label: 'API Keys', admin: true, group: 'system' },
  { key: 'health', icon: '🩺', label: 'System Health', admin: true, group: 'system' },
  // About sits on its own at the end
  { key: 'about', icon: 'ℹ️', label: 'About', group: 'about' },
]

const NAV_GROUP_LABELS: Record<string, string> = { account: 'Account', family: 'Family', system: 'System' }

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
]

function ageFrom(birthday: string | null | undefined): number | null {
  if (!birthday) return null
  const b = new Date(String(birthday))
  if (isNaN(b.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - b.getFullYear()
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--
  return age >= 0 ? age : null
}

function roleLine(m: SettingsMember): string {
  const parts: string[] = [m.memberType.charAt(0).toUpperCase() + m.memberType.slice(1)]
  if (m.isOwner) parts.push('Owner')
  else if (m.isAdmin) parts.push('Admin')
  const age = ageFrom(m.birthday)
  if (age != null && m.memberType !== 'adult') parts.push(`age ${age}`)
  if (m.hasLogin) parts.push('signed in')
  else if (m.memberType !== 'adult') parts.push('managed by parents')
  return parts.join(' · ')
}

function fmtBirthday(birthday: string | null | undefined): string | null {
  if (!birthday) return null
  const b = new Date(String(birthday))
  if (isNaN(b.getTime())) return null
  return b.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function MemberRow({ m, onClick }: { m: SettingsMember; onClick: () => void }) {
  const bday = fmtBirthday(m.birthday)
  return (
    <div className="set-member" onClick={onClick}>
      <div className="av md" style={{ background: `${m.colorHex ?? '#A6A29B'}22` }}>{m.avatarEmoji ?? '🙂'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="set-member-n">{m.name}</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>{roleLine(m)}</div>
      </div>
      {bday && <div className="tiny muted set-bday" style={{ fontWeight: 600 }}>🎂 {bday}</div>}
      <div className="set-swatch" style={{ background: m.colorHex ?? '#A6A29B' }} />
      <div className="set-chev">›</div>
    </div>
  )
}

function SettingRow({ icon, title, sub, children }: { icon: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="set-row2">
      <div className="set-ic2">{icon}</div>
      <div style={{ flex: 1 }}>
        <div className="set-row2-t">{title}</div>
        {sub && <div className="tiny muted" style={{ fontWeight: 600 }}>{sub}</div>}
      </div>
      {children}
    </div>
  )
}

// Role-based permissions grid (admin-only). Rows = roles (Adult/Teen/Kid),
// columns = the capabilities. Saves the whole matrix on each toggle (optimistic,
// reverts on failure) — matches the auto-save feel of the other settings cards.
// Admins always have everything, so they're not a row here.
const PERM_ROLES: Role[] = ['adult', 'teen', 'kid']
function PermissionsCard() {
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    permissionsApi.getPermissions()
      .then((d) => alive && setMatrix(d.permissions))
      .catch(() => alive && setError(true))
    return () => { alive = false }
  }, [])

  async function toggle(role: Role, cap: Capability) {
    if (!matrix || saving) return
    const prev = matrix
    const next: PermissionMatrix = { ...matrix, [role]: { ...matrix[role], [cap]: !matrix[role][cap] } }
    setMatrix(next)
    setSaving(true)
    try { setMatrix(await permissionsApi.setPermissions(next)) }
    catch { setMatrix(prev) }
    finally { setSaving(false) }
  }

  if (error) return null // non-admins (403) simply don't see this card
  return (
    <div className="set-card" style={{ marginTop: 18, padding: 18 }}>
      <div className="card-h" style={{ marginBottom: 4 }}>Permissions</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
        Choose what each role can do. Admins can always do everything. Everyone can always complete their own chores, redeem their own rewards, and log their own goals.
      </div>
      {matrix === null ? (
        <div className="tiny muted" style={{ fontWeight: 600 }}>Loading…</div>
      ) : (
        <div className="perm-grid" role="table" aria-label="Role permissions">
          <div className="perm-row perm-head" role="row">
            <span className="perm-role" role="columnheader" />
            {CAPABILITIES.map((cap) => (
              <span key={cap} className="perm-cap" role="columnheader">{CAPABILITY_LABELS[cap]}</span>
            ))}
          </div>
          {PERM_ROLES.map((role) => (
            <div key={role} className="perm-row" role="row">
              <span className="perm-role" role="rowheader">{ROLE_LABELS[role]}</span>
              {CAPABILITIES.map((cap) => (
                <span key={cap} className="perm-cell" role="cell">
                  <input
                    type="checkbox"
                    className="set-check"
                    checked={matrix[role][cap]}
                    disabled={saving}
                    aria-label={`${ROLE_LABELS[role]}: ${CAPABILITY_LABELS[cap]}`}
                    onChange={() => toggle(role, cap)}
                  />
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const HEALTH_ICON: Record<HealthStatus, string> = { ok: '✓', degraded: '⚠', down: '✗' }
const HEALTH_TITLE: Record<string, string> = {
  db: 'Database',
  migrations: 'Migrations',
  schedulers: 'Background jobs',
  calendar: 'Calendar sync',
  storage: 'Media storage',
  backup: 'Backups',
}

// One health check rendered as a card: status badge + its non-status fields as
// key=value chips (jobs get a friendlier per-job line).
type JobSnapshot = { name: string; lastRunAt: string | null; lastError: string | null; runCount: number }

function HealthCheckCard({ name, check }: { name: string; check: { status: HealthStatus } & Record<string, unknown> }) {
  const jobs = check.jobs as JobSnapshot[] | undefined
  const note = check.note as string | undefined
  const hint = check.hint as string | undefined
  const fields = Object.entries(check).filter(([k]) => k !== 'status' && k !== 'hint')
  return (
    <div className="set-card health-card" style={{ padding: 16 }}>
      <div className="health-card-h">
        <span className={`health-badge health-${check.status}`}>{HEALTH_ICON[check.status]}</span>
        <span className="card-h" style={{ margin: 0 }}>{HEALTH_TITLE[name] ?? name}</span>
      </div>
      {name === 'schedulers' && Array.isArray(jobs) ? (
        <div className="health-fields">
          {jobs.length === 0 ? (
            <span className="tiny muted">{note ?? 'no run history yet'}</span>
          ) : (
            jobs.map((j) => (
              <div key={j.name} className="tiny" style={{ fontWeight: 600 }}>
                {j.lastError ? '⚠' : '✓'} {j.name} · {j.runCount} runs{j.lastRunAt ? ` · last ${new Date(j.lastRunAt).toLocaleTimeString()}` : ''}{j.lastError ? ` · ${j.lastError}` : ''}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="health-fields">
          {fields.map(([k, v]) => (
            <span key={k} className="health-chip">{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
          ))}
        </div>
      )}
      {hint && <div className="health-hint">↳ {hint}</div>}
    </div>
  )
}

// Admin-only system health. Polls /api/health every 10s; a non-admin gets a 403 →
// we render nothing (the tab is admin-gated anyway, matching PermissionsCard).
// ── API Keys ────────────────────────────────────────────────────────────────────
// Per-user keys for external tools (Home Assistant, scripts, …). The secret is shown
// exactly once on creation. A key inherits the owner's role/capabilities; its scopes
// bound which resource families it can touch.
type ScopeLevel = 'none' | 'read' | 'write'

function scopeLabeler(scopes: ApiScopeDef[]): (scope: string) => string {
  const byResource = new Map(scopes.map((s) => [s.resource, s.label]))
  return (scope: string) => {
    const [resource, action] = scope.split(':')
    return `${byResource.get(resource) ?? resource} · ${action}`
  }
}

function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [catalog, setCatalog] = useState<ApiScopeDef[]>([])
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState<{ name: string; secret: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)

  const refetch = () => apiKeysApi.list().then(setKeys).catch(() => setKeys([]))
  useEffect(() => {
    refetch()
    apiKeysApi.listScopes().then(setCatalog).catch(() => setCatalog([]))
  }, [])

  const label = scopeLabeler(catalog)

  async function copySecret() {
    if (!justCreated) return
    try { await navigator.clipboard.writeText(justCreated.secret); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ }
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">API Keys</div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>+ New key</button>
      </div>
      <div className="tiny muted" style={{ fontWeight: 600, margin: '-6px 2px 16px', lineHeight: 1.45 }}>
        Give an external tool access to your household over the API. Send the key as the
        {' '}<code>x-api-key</code> header. A key acts as you — it can only do what your account can,
        limited further to the scopes you grant. Revoke it any time.
      </div>

      {justCreated && (
        <div className="apikey-reveal">
          <div className="apikey-reveal-h">🔑 Copy your new key now — you won't be able to see it again.</div>
          <div className="apikey-reveal-row">
            <code className="apikey-secret">{justCreated.secret}</code>
            <button type="button" className="btn btn-ghost apikey-copy" onClick={copySecret}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </div>
          <button type="button" className="btn btn-ghost tiny" style={{ marginTop: 10 }} onClick={() => setJustCreated(null)}>Done</button>
        </div>
      )}

      {keys == null ? (
        <div className="tiny muted" style={{ fontWeight: 600, padding: 8 }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div className="tiny muted" style={{ fontWeight: 600, padding: '14px 2px' }}>No API keys yet. Create one to let an outside app reach Waffled.</div>
      ) : (
        <div className="apikey-list">
          {keys.map((k) => (
            <div key={k.id} className="apikey-row">
              <div className="apikey-main">
                <div className="apikey-name">{k.name}</div>
                <code className="apikey-prefix">{k.prefix}…</code>
                <div className="apikey-scopes">
                  {k.scopes.length ? k.scopes.map((s) => <span key={s} className="apikey-scope">{label(s)}</span>) : <span className="tiny muted">no scopes</span>}
                </div>
                <div className="tiny muted apikey-meta">
                  {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'Never used'}
                  {' · '}Created {new Date(k.createdAt).toLocaleDateString()}
                  {k.expiresAt ? ` · Expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <button type="button" className="btn btn-ghost apikey-revoke" onClick={() => setRevoking(k)}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewApiKeyModal
          catalog={catalog}
          onClose={() => setCreating(false)}
          onCreated={(name, secret) => { setCreating(false); setJustCreated({ name, secret }); setCopied(false); refetch() }}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke "${revoking.name}"?`}
          message="Any tool using this key will immediately lose access. This can't be undone."
          confirmLabel="Revoke"
          danger
          onConfirm={async () => { await apiKeysApi.revoke(revoking.id); setRevoking(null); refetch() }}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  )
}

function NewApiKeyModal({ catalog, onClose, onCreated }: {
  catalog: ApiScopeDef[]
  onClose: () => void
  onCreated: (name: string, secret: string) => void
}) {
  const [name, setName] = useState('')
  const [levels, setLevels] = useState<Record<string, ScopeLevel>>({})
  const [expiresAt, setExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const setLevel = (resource: string, level: ScopeLevel) => setLevels((m) => ({ ...m, [resource]: level }))

  function buildScopes(): string[] {
    return Object.entries(levels)
      .filter(([, l]) => l !== 'none')
      .map(([resource, l]) => `${resource}:${l}`)
  }

  async function save() {
    const scopes = buildScopes()
    if (!name.trim()) { setErr('Give the key a name.'); return }
    if (scopes.length === 0) { setErr('Grant at least one scope.'); return }
    setSaving(true)
    setErr(null)
    try {
      const res = await apiKeysApi.create({ name: name.trim(), scopes, expiresAt: expiresAt || null })
      onCreated(res.apiKey.name, res.key)
    } catch {
      setErr('Could not create the key — please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="wf-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>New API key</div>
        <label className="pantry-field"><span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Home Assistant" autoFocus />
        </label>
        <div className="pantry-field"><span>Scopes</span></div>
        <div className="apikey-scopegrid">
          {catalog.map((s) => {
            const level = levels[s.resource] ?? 'none'
            return (
              <div key={s.resource} className="apikey-scoperow">
                <div className="apikey-scoperow-main">
                  <div className="apikey-scoperow-label">{s.label}</div>
                  <div className="tiny muted">{s.description}{s.readOnly ? ' · read-only' : ''}</div>
                </div>
                <div className="apikey-seg">
                  <button type="button" className={level === 'none' ? 'on' : ''} onClick={() => setLevel(s.resource, 'none')}>None</button>
                  <button type="button" className={level === 'read' ? 'on' : ''} onClick={() => setLevel(s.resource, 'read')}>Read</button>
                  {!s.readOnly && <button type="button" className={level === 'write' ? 'on' : ''} onClick={() => setLevel(s.resource, 'write')}>Write</button>}
                </div>
              </div>
            )
          })}
        </div>
        <label className="pantry-field" style={{ marginTop: 12 }}><span>Expires (optional)</span>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
        {err && <div className="pantry-err">{err}</div>}
        <div className="pantry-modal-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Creating…' : 'Create key'}</button>
        </div>
      </div>
    </div>
  )
}

function SystemHealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null)
  const [error, setError] = useState(false)
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [togglingUpd, setTogglingUpd] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () =>
      healthApi.get().then((d) => alive && setReport(d)).catch(() => alive && setError(true))
    load()
    const t = setInterval(load, 10000)
    // Update check is a slow outbound call (cached server-side) — fetch once, not on the loop.
    updatesApi.get().then((d) => alive && setUpd(d)).catch(() => {})
    return () => { alive = false; clearInterval(t) }
  }, [])

  async function toggleUpd(v: boolean) {
    setTogglingUpd(true)
    try {
      await updatesApi.setEnabled(v)
      setUpd(await updatesApi.get())
    } finally {
      setTogglingUpd(false)
    }
  }

  if (error) return null
  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">System Health</div>
        {report && (
          <span className={`health-badge health-${report.status} health-badge-lg`} title={`Overall: ${report.status}`}>
            {HEALTH_ICON[report.status]} {report.status.toUpperCase()}
          </span>
        )}
      </div>
      <div className="tiny muted" style={{ fontWeight: 600, margin: '-6px 2px 14px' }}>
        Live status of the self-hosted stack. Same data as <code>./waffled doctor</code> in a terminal.
      </div>
      {upd && <UpdateBanner upd={upd} onToggle={toggleUpd} toggling={togglingUpd} />}
      {!report ? (
        <div className="tiny muted" style={{ fontWeight: 600, padding: 8 }}>Loading…</div>
      ) : (
        <>
          <div className="health-grid">
            {Object.entries(report.checks).map(([name, check]) => (
              <HealthCheckCard key={name} name={name} check={check} />
            ))}
          </div>
          <div className="tiny muted" style={{ fontWeight: 600, marginTop: 12 }}>
            Build {report.version.sha}{report.version.buildTime ? ` · ${new Date(report.version.buildTime).toLocaleString()}` : ''} · refreshed {new Date(report.generatedAt).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  )
}

// Update notifier row inside System Health: "update available / up to date / off",
// with an admin toggle. Hidden entirely when the operator disabled it via env.
function UpdateBanner({ upd, onToggle, toggling }: { upd: UpdateInfo; onToggle: (v: boolean) => void; toggling: boolean }) {
  const envOff = !upd.enabled && upd.reason === 'env'
  return (
    <div className="set-card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          {upd.updateAvailable && upd.latest ? (
            <>
              <div className="card-h" style={{ margin: 0 }}>⬆ Update available — {upd.latest.tag}</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>
                You're on {upd.current.version} ({upd.current.sha}).{' '}
                <a href={upd.latest.url} target="_blank" rel="noreferrer">View release ↗</a>
              </div>
            </>
          ) : upd.enabled && upd.latest ? (
            <>
              <div className="card-h" style={{ margin: 0 }}>✓ Up to date</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>
                Running {upd.current.version} ({upd.current.sha}) · latest is {upd.latest.tag}
              </div>
            </>
          ) : upd.enabled ? (
            <>
              <div className="card-h" style={{ margin: 0 }}>Update check</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>
                Running {upd.current.version} ({upd.current.sha}){upd.error ? ` · ${upd.error}` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="card-h" style={{ margin: 0 }}>Update checks off</div>
              <div className="tiny muted" style={{ fontWeight: 600 }}>
                {envOff ? 'Disabled by the operator (UPDATE_CHECK_ENABLED).' : "Waffled won't check GitHub for new releases."}
              </div>
            </>
          )}
        </div>
        {!envOff && <Switch checked={upd.enabled} disabled={toggling} onChange={onToggle} ariaLabel="Check for updates" />}
      </div>
    </div>
  )
}

// Same swatch palette the Family & People person editor uses, so a member's
// self-service color picker matches what an admin sees.
const ACCOUNT_SWATCHES = ['#2F7FED', '#EC6049', '#25A368', '#8B5CF6', '#E0A500', '#EC4899', '#14B8A6', '#6B7280']

// Pull the server's `{ error, message }` message off a caught apiSend error
// (ApiSendError carries `.body`), falling back to a friendly default.
function accountErrMsg(e: unknown, fallback: string): string {
  const body = (e as { body?: { message?: string } })?.body
  return body?.message || fallback
}

// ── My Profile ────────────────────────────────────────────────────────────────
// A signed-in member edits their OWN name, avatar, color, and birthday. Everything
// else about the person (role, login, kiosk visibility) stays admin-managed.
function MyProfilePanel() {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [error, setError] = useState(false)
  const [name, setName] = useState('')
  const [avatarEmoji, setAvatarEmoji] = useState('')
  const [colorHex, setColorHex] = useState(ACCOUNT_SWATCHES[0])
  const [birthday, setBirthday] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    accountApi.get()
      .then((a) => {
        if (!alive) return
        setInfo(a)
        setName(a.name)
        setAvatarEmoji(a.avatarEmoji ?? '🙂')
        setColorHex(a.colorHex ?? ACCOUNT_SWATCHES[0])
        setBirthday(a.birthday ? String(a.birthday).slice(0, 10) : '')
      })
      .catch(() => alive && setError(true))
    return () => { alive = false }
  }, [])

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Couldn't load your profile — try reloading or signing in again.</div></div>
  if (!info) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>

  const dirty =
    name.trim() !== info.name ||
    (avatarEmoji.trim() || null) !== (info.avatarEmoji ?? null) ||
    colorHex !== (info.colorHex ?? ACCOUNT_SWATCHES[0]) ||
    (birthday || null) !== (info.birthday ? String(info.birthday).slice(0, 10) : null)

  async function save() {
    if (!name.trim() || saving) return
    setSaving(true); setSaved(false); setSaveErr(null)
    try {
      await accountApi.updateProfile({
        name: name.trim(),
        avatarEmoji: avatarEmoji.trim() || '🙂',
        colorHex,
        birthday: birthday || null,
      })
      // Reflect the saved values back so `dirty` resets.
      setInfo((i) => (i ? { ...i, name: name.trim(), avatarEmoji: avatarEmoji.trim() || null, colorHex, birthday: birthday || null } : i))
      emitHouseholdChanged() // refresh topbar avatar/name immediately
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch (e) {
      setSaveErr(accountErrMsg(e, 'Could not save your profile — please try again.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">My Profile</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>How you appear on the kiosk</div>
      </div>

      <div className="set-card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <div className="av md" style={{ background: `${colorHex}22`, fontSize: 26 }}>{avatarEmoji || '🙂'}</div>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Name</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }} placeholder="Your name" />
          </div>
          <div className="field" style={{ width: 80, marginBottom: 0 }}>
            <span>Avatar</span>
            <input value={avatarEmoji} onChange={(e) => { setAvatarEmoji(e.target.value); setSaved(false) }} placeholder="🙂" maxLength={4} />
          </div>
        </div>

        <div className="field">
          <span>Color</span>
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            {ACCOUNT_SWATCHES.map((c) => (
              <button
                type="button"
                key={c}
                aria-label={`color ${c}`}
                onClick={() => { setColorHex(c); setSaved(false) }}
                style={{ width: 30, height: 30, borderRadius: 999, background: c, border: colorHex === c ? '3px solid var(--ink)' : '2px solid #fff', boxShadow: '0 0 0 1px var(--hair)', cursor: 'pointer' }}
              />
            ))}
          </div>
        </div>

        <label className="field">
          <span>Birthday (optional)</span>
          <input type="date" value={birthday} onChange={(e) => { setBirthday(e.target.value); setSaved(false) }} />
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || !name.trim() || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
        </div>
        {saveErr && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{saveErr}</div>}
      </div>
    </div>
  )
}

// ── My Account ────────────────────────────────────────────────────────────────
// Login & security for the signed-in member: change email and password. OIDC
// members can't change either here — those live with their SSO provider.
function MyAccountPanel() {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [error, setError] = useState(false)

  // Change email
  const [email, setEmail] = useState('')
  const [emailPw, setEmailPw] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailOk, setEmailOk] = useState(false)
  const [emailErr, setEmailErr] = useState<string | null>(null)

  // Change password
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwOk, setPwOk] = useState(false)
  const [pwErr, setPwErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    accountApi.get()
      .then((a) => { if (!alive) return; setInfo(a); setEmail(a.email ?? '') })
      .catch(() => alive && setError(true))
    return () => { alive = false }
  }, [])

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Couldn't load your account — try reloading or signing in again.</div></div>
  if (!info) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>

  async function saveEmail() {
    if (!info || emailBusy) return
    setEmailBusy(true); setEmailOk(false); setEmailErr(null)
    try {
      await accountApi.changeEmail({ email: email.trim(), currentPassword: emailPw })
      setInfo((i) => (i ? { ...i, email: email.trim() } : i))
      setEmailPw('')
      setEmailOk(true)
      setTimeout(() => setEmailOk(false), 2500)
    } catch (e) {
      setEmailErr(accountErrMsg(e, 'Could not change your email — please try again.'))
    } finally {
      setEmailBusy(false)
    }
  }

  async function savePassword() {
    if (pwBusy) return
    if (newPw.length < 8) { setPwErr('New password must be at least 8 characters.'); return }
    if (newPw !== confirmPw) { setPwErr('Those passwords don’t match.'); return }
    setPwBusy(true); setPwOk(false); setPwErr(null)
    try {
      await accountApi.changePassword({ currentPassword: curPw, newPassword: newPw })
      setCurPw(''); setNewPw(''); setConfirmPw('')
      setPwOk(true)
      setTimeout(() => setPwOk(false), 2500)
    } catch (e) {
      setPwErr(accountErrMsg(e, 'Could not change your password — please try again.'))
    } finally {
      setPwBusy(false)
    }
  }

  const oidc = info.provider === 'oidc'

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">My Account</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>Login &amp; security</div>
      </div>

      {oidc ? (
        <div className="set-card" style={{ padding: 18 }}>
          <div className="set-row2-t" style={{ marginBottom: 4 }}>Email</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{info.email}</div>
          <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>
            Managed by your SSO provider — change it there.
          </div>
        </div>
      ) : (
        <>
          <div className="set-card" style={{ padding: 18 }}>
            <div className="set-row2-t" style={{ marginBottom: 12 }}>Change email</div>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Email</span>
              <input type="email" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); setEmailOk(false) }} placeholder="name@example.com" />
            </label>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={emailPw} onChange={(e) => { setEmailPw(e.target.value); setEmailOk(false) }} placeholder="Enter your current password" />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="btn btn-primary" onClick={saveEmail} disabled={emailBusy || !email.trim() || !emailPw || email.trim() === (info.email ?? '')}>
                {emailBusy ? 'Saving…' : 'Update email'}
              </button>
              {emailOk && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
            </div>
            {emailErr && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{emailErr}</div>}
          </div>

          <div className="set-card" style={{ padding: 18, marginTop: 16 }}>
            <div className="set-row2-t" style={{ marginBottom: 12 }}>Change password</div>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={curPw} onChange={(e) => { setCurPw(e.target.value); setPwOk(false) }} placeholder="Enter your current password" />
            </label>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>New password</span>
              <input type="password" autoComplete="new-password" value={newPw} onChange={(e) => { setNewPw(e.target.value); setPwOk(false) }} placeholder="At least 8 characters" />
            </label>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Confirm new password</span>
              <input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => { setConfirmPw(e.target.value); setPwOk(false) }} placeholder="Re-enter new password" />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="btn btn-primary" onClick={savePassword} disabled={pwBusy || !curPw || !newPw || !confirmPw}>
                {pwBusy ? 'Saving…' : 'Update password'}
              </button>
              {pwOk && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
            </div>
            {pwErr && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{pwErr}</div>}
          </div>
        </>
      )}

      <KioskPinCard personId={info.personId} hasPin={info.hasPin} />
    </div>
  )
}

// The kiosk PIN opens your profile on the shared tablet's picker — separate from your
// email/password sign-in, and available even to SSO members. Self-service (the API
// route is self-or-admin). 4–8 digits.
function KioskPinCard({ personId, hasPin }: { personId: string; hasPin: boolean }) {
  const [pinSet, setPinSet] = useState(hasPin)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const [err, setErr] = useState('')
  const valid = /^\d{4,8}$/.test(pin)
  async function save() {
    setBusy(true); setErr(''); setOk(false)
    try { await accountApi.setPin(personId, pin); setPin(''); setPinSet(true); setOk(true) }
    catch (e) { setErr(accountErrMsg(e, 'Could not set your PIN — please try again.')) }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setErr(''); setOk(false)
    try { await accountApi.removePin(personId); setPinSet(false); setPin(''); setOk(true) }
    catch (e) { setErr(accountErrMsg(e, 'Could not remove your PIN — please try again.')) }
    finally { setBusy(false) }
  }
  return (
    <div className="set-card" style={{ padding: 18, marginTop: 16 }}>
      <div className="set-row2-t" style={{ marginBottom: 4 }}>Kiosk PIN</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 12 }}>
        An optional 4–8 digit PIN to open your profile on the shared kiosk. {pinSet ? 'A PIN is set.' : 'No PIN set.'}
      </div>
      <label className="field" style={{ marginBottom: 10 }}>
        <span>{pinSet ? 'New PIN' : 'PIN'}</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setOk(false) }}
          placeholder="4–8 digits"
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !valid}>
          {busy ? 'Saving…' : pinSet ? 'Update PIN' : 'Set PIN'}
        </button>
        {pinSet && <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy}>Remove PIN</button>}
        {ok && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
      </div>
      {err && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginTop: 10 }}>{err}</div>}
    </div>
  )
}

function FamilyPanel() {
  const { household, members, loading, error, refetch } = useHouseholdSettings()
  const [editing, setEditing] = useState<SettingsMember | null>(null)
  const [adding, setAdding] = useState(false)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [locDraft, setLocDraft] = useState<string | null>(null)

  if (loading) return <div className="muted" style={{ padding: 20 }}>Loading…</div>
  if (error || !household) return <div className="muted" style={{ padding: 20 }}>Couldn't load your family — try reloading or signing in again.</div>

  async function saveHousehold(patch: Record<string, unknown>) {
    await personsApi.updateHousehold(patch)
    emitHouseholdChanged() // refresh the topbar clock/name immediately
    refetch()
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Family &amp; People</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>{members.length} {members.length === 1 ? 'person' : 'people'}</div>
      </div>

      <div className="set-card">
        {members.map((m) => (
          <MemberRow key={m.id} m={m} onClick={() => setEditing(m)} />
        ))}
      </div>
      <button type="button" className="btn btn-ghost set-add" onClick={() => setAdding(true)}>＋ Add a person</button>

      <div className="set-card" style={{ marginTop: 18 }}>
        <SettingRow icon="🏡" title="Household name" sub="Shows on the kiosk &amp; invites">
          {nameDraft === null ? (
            <button type="button" className="sel" onClick={() => setNameDraft(household.name)}>{household.name} ▾</button>
          ) : (
            <input
              className="set-inline-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft.trim() && nameDraft !== household.name) saveHousehold({ name: nameDraft.trim() })
                setNameDraft(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </SettingRow>
        <SettingRow icon="🗓️" title="Week starts on">
          <select className="sel" value={household.weekStart} onChange={(e) => saveHousehold({ weekStart: e.target.value })}>
            <option value="sunday">Sunday</option>
            <option value="monday">Monday</option>
          </select>
        </SettingRow>
        <SettingRow icon="🌐" title="Time zone" sub="Used for every calendar &amp; reminder">
          <select className="sel" value={household.timezone} onChange={(e) => saveHousehold({ timezone: e.target.value })}>
            {(TIMEZONES.includes(household.timezone) ? TIMEZONES : [household.timezone, ...TIMEZONES]).map((tz) => (
              <option key={tz} value={tz}>{tz.split('/').pop()?.replace('_', ' ')}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow icon="📍" title="Location" sub="For local weather on the kiosk (weather wiring coming soon)">
          {locDraft === null ? (
            <button type="button" className="sel" onClick={() => setLocDraft(household.location ?? '')}>
              {household.location || 'Set location'} ▾
            </button>
          ) : (
            <input
              className="set-inline-input"
              autoFocus
              placeholder="City, State"
              value={locDraft}
              onChange={(e) => setLocDraft(e.target.value)}
              onBlur={() => {
                if ((locDraft.trim() || null) !== (household.location ?? null)) saveHousehold({ location: locDraft.trim() || null })
                setLocDraft(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          )}
        </SettingRow>
      </div>

      <PermissionsCard />

      {(editing || adding) && (
        <PersonModal person={editing} onClose={() => { setEditing(null); setAdding(false) }} onSaved={refetch} />
      )}
    </div>
  )
}

const PROVIDER_META: Record<Provider, { label: string; sub: string; envHint: string }> = {
  heuristic: { label: 'On-device', sub: 'Built-in parser — no AI, works offline', envHint: '' },
  anthropic: { label: 'Claude (Anthropic)', sub: 'Most accurate · hosted', envHint: 'ANTHROPIC_API_KEY' },
  openai: { label: 'OpenAI / compatible', sub: 'Hosted, or a local OpenAI-compatible server', envHint: 'OPENAI_API_KEY' },
  ollama: { label: 'Local server (Ollama)', sub: 'Private — text stays on your network', envHint: 'OLLAMA_HOST' },
}
const PROVIDER_ORDER: Provider[] = ['heuristic', 'ollama', 'anthropic', 'openai']

// Smart matching: the per-household learned word→goal cache that powers calendar
// suggestions + auto-link. View what's been learned and forget any of it (a single
// word, or all of it) — so a wrong pattern can be corrected.
function LearnedMatches() {
  const [groups, setGroups] = useState<MemoryGroup[] | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const load = () => goalCalendarApi.memory().then((d) => setGroups(d.groups)).catch(() => setGroups([]))
  useEffect(() => { load() }, [])

  async function forget(goalId: string, token: string) {
    await goalCalendarApi.forgetMemory({ goalId, token })
    load()
  }
  async function clearAll() {
    if (!confirmClear) { setConfirmClear(true); return }
    await goalCalendarApi.clearMemory()
    setConfirmClear(false)
    load()
  }
  if (groups === null) return null

  return (
    <div className="set-card" style={{ marginTop: 18 }}>
      <div className="set-row2-t" style={{ marginBottom: 4 }}>Smart matching</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 12 }}>
        Words Waffled has learned to link to a goal, from the events you’ve linked. Remove any that look wrong.
      </div>
      {groups.length === 0 ? (
        <div className="tiny muted" style={{ fontWeight: 600 }}>
          Nothing learned yet — link a few events to goals and it’ll start remembering.
        </div>
      ) : (
        <div className="sm-list">
          {groups.map((g) => (
            <div key={g.goalId} className="sm-group">
              <div className="sm-goal">{g.goalEmoji ? `${g.goalEmoji} ` : ''}{g.goalTitle}</div>
              <div className="sm-chips">
                {g.tokens.map((t) => (
                  <button key={t.token} type="button" className="sm-chip" onClick={() => forget(g.goalId, t.token)} title="Forget this word">
                    {t.token}<span className="sm-x">✕</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {groups.length > 0 && (
        <button type="button" className="btn btn-ghost" style={{ marginTop: 14 }} onClick={clearAll}>
          {confirmClear ? 'Tap again to reset everything' : 'Reset learned matches'}
        </button>
      )}
    </div>
  )
}

// AI & capture: pick which engine parses the "Add anything" bar. Credentials live
// in the server environment (docker-compose / .env) — this only flips the active
// provider + model. Providers without a key/host configured are disabled here.
function AiPanel() {
  const [cfg, setCfg] = useState<CaptureConfig | null>(null)
  const [provider, setProvider] = useState<Provider>('heuristic')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    captureApi
      .getConfig()
      .then((c) => {
        if (!alive) return
        setCfg(c)
        setProvider(c.provider)
        setModel(c.model ?? '')
      })
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [])

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Couldn't load AI settings — try reloading or signing in again.</div></div>
  if (!cfg) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>

  function pick(p: Provider) {
    if (p !== 'heuristic' && !cfg!.available[p]) return
    setProvider(p)
    setSaved(false)
    if (p !== 'heuristic') setModel(cfg!.defaultModels[p as 'anthropic' | 'openai' | 'ollama'])
    else setModel('')
  }

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const m = provider === 'heuristic' ? null : model.trim() || null
      const r = await captureApi.setConfig(provider, m)
      setCfg({ ...cfg!, provider: r.provider, model: r.model })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const dirty = provider !== cfg.provider || (provider !== 'heuristic' && (model.trim() || null) !== (cfg.model ?? null))

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">AI &amp; Capture</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>Powers the “Add anything” bar</div>
      </div>

      <div className="set-card">
        {PROVIDER_ORDER.map((p) => {
          const meta = PROVIDER_META[p]
          const on = provider === p
          const enabled = p === 'heuristic' || cfg.available[p]
          return (
            <button
              type="button"
              key={p}
              className={`ai-prov ${on ? 'on' : ''}`}
              onClick={() => pick(p)}
              disabled={!enabled}
              aria-pressed={on}
            >
              <span className={`ai-radio ${on ? 'on' : ''}`} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                <span className="set-row2-t">{meta.label}</span>
                <span className="tiny muted" style={{ display: 'block', fontWeight: 600 }}>
                  {enabled ? meta.sub : `Set ${meta.envHint} in the server environment to enable`}
                </span>
              </span>
              {p !== 'heuristic' && (
                <span className={`ai-badge ${enabled ? 'ok' : ''}`}>{enabled ? 'key detected' : 'not configured'}</span>
              )}
            </button>
          )
        })}
      </div>

      {provider !== 'heuristic' && (
        <div className="set-card" style={{ marginTop: 16 }}>
          <SettingRow icon="🧠" title="Model" sub="Overrides the server default for this provider">
            <input
              className="set-inline-input"
              value={model}
              onChange={(e) => { setModel(e.target.value); setSaved(false) }}
              placeholder={cfg.defaultModels[provider as 'anthropic' | 'openai' | 'ollama']}
              style={{ minWidth: 200 }}
            />
          </SettingRow>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
        <span className="tiny muted" style={{ fontWeight: 600 }}>
          Keys are read from the server environment and never leave it.
        </span>
      </div>

      <LearnedMatches />
    </div>
  )
}

const MEAL_TIME_ROWS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'breakfast', label: 'Breakfast', icon: '🍳' },
  { key: 'lunch', label: 'Lunch', icon: '🥪' },
  { key: 'dinner', label: 'Dinner', icon: '🍽️' },
  { key: 'snack', label: 'Snack', icon: '🍎' },
]

// Pantry staples — assumed-in-house items the grocery auto-build leaves off the
// list. Same list shown on the Lists grocery board's "Edit staples"; managed here
// too so it lives with the other meal settings.
function StaplesEditor() {
  const [staples, setStaples] = useState<PantryStaple[] | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => groceryApi.pantryStaples().then((r) => setStaples(r.staples)).catch(() => setStaples([]))
  useEffect(() => { load() }, [])
  async function add(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim()
    if (!name || busy) return
    setBusy(true)
    try { await groceryApi.addStaple(name); setDraft(''); await load() } finally { setBusy(false) }
  }
  async function remove(id: string) { await groceryApi.removeStaple(id); await load() }
  return (
    <div className="set-card" style={{ marginTop: 16 }}>
      <div className="set-row2-t" style={{ margin: '2px 2px 4px' }}>Pantry staples</div>
      <div className="tiny muted" style={{ fontWeight: 600, margin: '0 2px 12px' }}>
        Assumed in the house — the grocery list leaves these off. Manage them here or from the Lists grocery board.
      </div>
      <form onSubmit={add} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input className="set-inline-input" style={{ flex: 1, width: 'auto' }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a staple… (e.g. Soy sauce)" />
        <button type="submit" className="btn btn-primary" disabled={!draft.trim() || busy}>Add</button>
      </form>
      <div className="grocery-staples">
        {(staples ?? []).map((s) => (
          <span key={s.id} className="staple-chip editable">
            {s.name}
            <button type="button" aria-label={`Remove ${s.name}`} onClick={() => remove(s.id)}>×</button>
          </span>
        ))}
        {staples != null && staples.length === 0 && (
          <div className="tiny muted" style={{ fontWeight: 600 }}>No staples yet — add the things you always have.</div>
        )}
      </div>
    </div>
  )
}

// Meals: how planned meals show up on the calendar — whether at all, whether they
// push to Google, whose calendar they belong to, who's invited, and the time each
// meal type lands at. Changes re-sync meals already on the plan.
function MealsPanel() {
  const { persons } = usePersons()
  const [cfg, setCfg] = useState<MealCalendarSettings | null>(null)
  const [error, setError] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  // Auto-save (like pantry staples) — no Save button, so meal settings and
  // staples behave the same. dirtyRef gates the debounced save so echoing the
  // server's normalized cfg back into state doesn't trigger another save.
  const dirtyRef = useRef(false)

  useEffect(() => {
    mealsApi
      .calendarSettings()
      .then((s) => { setCfg(s); setError(false) })
      .catch(() => setError(true))
  }, [])

  function update(patch: Partial<MealCalendarSettings>) {
    setCfg((c) => (c ? { ...c, ...patch } : c))
    dirtyRef.current = true
  }

  useEffect(() => {
    if (!cfg || !dirtyRef.current) return
    const t = setTimeout(async () => {
      try {
        const s = await mealsApi.setCalendarSettings(cfg)
        dirtyRef.current = false
        setCfg(s)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1800)
      } catch {
        setError(true)
      }
    }, 600)
    return () => clearTimeout(t)
  }, [cfg])

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Couldn't load meal settings — try reloading or signing in again.</div></div>
  if (!cfg) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>

  // null participantIds == the whole family; resolve to concrete ids for the chips.
  const allIds = persons.map((p) => p.id)
  const selected = cfg.participantIds ?? allIds
  function toggleParticipant(id: string) {
    const next = selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id]
    // all selected ⇒ collapse back to "whole family" (null)
    update({ participantIds: next.length === allIds.length ? null : next })
  }

  return (
    <div className="set-panel">
      <div className="set-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div className="wf-serif set-head-t">Meals</div>
        {savedFlash && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved · meals updated</span>}
        <span className="tiny muted" style={{ marginLeft: 'auto', fontWeight: 600 }}>Changes save automatically</span>
      </div>

      <div className="set-card">
        <SettingRow icon="📅" title="Add planned meals to the calendar" sub="Each meal you plan shows on the Waffled calendar, linked to its recipe.">
          <input type="checkbox" className="set-check" checked={cfg.addToCalendar} onChange={(e) => update({ addToCalendar: e.target.checked })} />
        </SettingRow>
        <SettingRow icon="🔄" title="Sync them to Google Calendar" sub="Also push meal events to the calendar below, so they show on everyone’s phones.">
          <input type="checkbox" className="set-check" disabled={!cfg.addToCalendar} checked={cfg.addToCalendar && cfg.pushToGoogle} onChange={(e) => update({ pushToGoogle: e.target.checked })} />
        </SettingRow>
        <SettingRow icon="👤" title="Add to this person’s calendar" sub="Meal events use this person’s color and their Google write-target calendar.">
          <select className="sel" disabled={!cfg.addToCalendar} value={cfg.calendarPersonId ?? ''} onChange={(e) => update({ calendarPersonId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {persons.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div className="set-card" style={{ marginTop: 16 }}>
        <SettingRow icon="🧑‍🤝‍🧑" title="Who’s invited" sub={cfg.participantIds === null ? 'The whole family' : `${selected.length} ${selected.length === 1 ? 'person' : 'people'}`}>
          <div />
        </SettingRow>
        <div className="meal-chips">
          <button type="button" className={`tag ${cfg.participantIds === null ? 'on' : ''}`} disabled={!cfg.addToCalendar} onClick={() => update({ participantIds: null })}>Whole family</button>
          {persons.map((p) => (
            <button key={p.id} type="button" className={`tag ${selected.includes(p.id) ? 'on' : ''}`} disabled={!cfg.addToCalendar} onClick={() => toggleParticipant(p.id)}>
              {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}{p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="set-card" style={{ marginTop: 16 }}>
        <div className="set-row2-t" style={{ margin: '2px 2px 4px' }}>Meal times</div>
        <div className="tiny muted" style={{ fontWeight: 600, margin: '0 2px 12px' }}>When each meal lands on the calendar.</div>
        {MEAL_TIME_ROWS.map((m) => (
          <SettingRow key={m.key} icon={m.icon} title={m.label}>
            <input
              type="time"
              className="set-inline-input"
              disabled={!cfg.addToCalendar}
              value={cfg.times[m.key] ?? ''}
              onChange={(e) => update({ times: { ...cfg.times, [m.key]: e.target.value } })}
            />
          </SettingRow>
        ))}
      </div>

      <StaplesEditor />
    </div>
  )
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'never'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Subscriptions you can't edit (holidays, other people's calendars) come back as
// reader / freeBusyReader; owner/writer are your own read-write calendars.
function isReadOnly(accessRole: string | null): boolean {
  return accessRole === 'reader' || accessRole === 'freeBusyReader'
}

// Calendars: connect Google accounts, map each calendar to a person (color/owner),
// toggle which ones Waffled syncs, and pull events on demand. Connect navigates to
// Google's consent screen; the api callback redirects back here when it's done.
function CalendarsPanel() {
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const { persons } = usePersons()
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [syncedOnly, setSyncedOnly] = useState(false)
  const [hideReadOnly, setHideReadOnly] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  function load() {
    calendarsApi
      .calendarStatus()
      .then((s) => { setStatus(s); setLoading(false); setError(false) })
      .catch(() => { setError(true); setLoading(false) })
  }
  useEffect(load, [])

  if (loading) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>
  if (error || !status) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Couldn't load calendars — try reloading or signing in again.</div></div>

  async function connect() {
    setConnecting(true)
    try {
      const { url } = await calendarsApi.connectCalendar(window.location.href)
      window.location.href = url // full-page handoff to Google's consent screen
    } catch {
      setConnecting(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await calendarsApi.syncCalendars()
      const errs = r.calendars.filter((c) => c.error)
      setSyncMsg(
        errs.length
          ? `Synced with ${errs.length} error${errs.length > 1 ? 's' : ''}: ${errs[0].error}`
          : `Imported ${r.imported}, updated ${r.updated}, removed ${r.deleted}.`
      )
      load()
    } catch {
      setSyncMsg('Sync failed — check the server logs.')
    } finally {
      setSyncing(false)
    }
  }

  function replaceCal(updated: CalendarLink) {
    setStatus((s) => (s ? { ...s, calendars: s.calendars.map((c) => (c.id === updated.id ? updated : c)) } : s))
  }
  async function setPerson(cal: CalendarLink, personId: string) {
    const { calendar } = await calendarsApi.updateCalendar(cal.id, { personId: personId || null })
    replaceCal(calendar)
  }
  async function toggleSelected(cal: CalendarLink) {
    const { calendar } = await calendarsApi.updateCalendar(cal.id, { selected: !cal.selected })
    replaceCal(calendar)
  }
  // Setting a write target clears the flag on the person's other calendars, so
  // refetch the whole list rather than patching a single row.
  async function toggleWriteTarget(cal: CalendarLink) {
    await calendarsApi.updateCalendar(cal.id, { isWriteTarget: !cal.isWriteTarget })
    load()
  }
  async function disconnect(accountId: string) {
    if (!window.confirm('Disconnect this Google account? Its calendars stop syncing (already-imported events stay).')) return
    await calendarsApi.disconnectAccount(accountId)
    load()
  }
  // Flip every (currently visible) calendar in an account on or off at once.
  async function setAll(cals: CalendarLink[], selected: boolean) {
    const toChange = cals.filter((c) => c.selected !== selected)
    const updated = await Promise.all(toChange.map((c) => calendarsApi.updateCalendar(c.id, { selected })))
    setStatus((s) => {
      if (!s) return s
      const byId = new Map(updated.map((u) => [u.calendar.id, u.calendar]))
      return { ...s, calendars: s.calendars.map((c) => byId.get(c.id) ?? c) }
    })
  }

  function CalRow({ cal }: { cal: CalendarLink }) {
    // A calendar can be a write target only if it's writable and owned by a person.
    const canTarget = !!cal.personId && !isReadOnly(cal.accessRole)
    return (
      <div className="set-row2">
        <div className="set-ic2" style={{ background: `${cal.colorHex ?? '#A6A29B'}22` }}>📅</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="set-row2-t" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cal.summary ?? cal.googleCalendarId}
            {cal.isPrimary && <span className="tiny muted" style={{ fontWeight: 600 }}> · primary</span>}
          </div>
          <div className="tiny muted" style={{ fontWeight: 600 }}>
            {cal.selected ? `Last synced ${fmtWhen(cal.lastSyncedAt)}` : 'Sync off'}
            {cal.accessRole ? ` · ${cal.accessRole}` : ''}
            {cal.isWriteTarget && <span style={{ color: 'var(--accent, #4c8bf5)' }}> · ★ new events go here</span>}
          </div>
        </div>
        {canTarget && (
          <button
            type="button"
            className={`cal-star ${cal.isWriteTarget ? 'on' : ''}`}
            onClick={() => toggleWriteTarget(cal)}
            title={cal.isWriteTarget ? 'Default calendar for new events for this person' : 'Make this the default for new events for this person'}
            aria-pressed={cal.isWriteTarget}
          >
            {cal.isWriteTarget ? '★' : '☆'}
          </button>
        )}
        <select
          className="sel"
          value={cal.personId ?? ''}
          onChange={(e) => setPerson(cal, e.target.value)}
          title="Who owns this calendar (sets event color)"
        >
          <option value="">Unassigned</option>
          {persons.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="cal-sync" title="Sync this calendar into Waffled">
          <input type="checkbox" checked={cal.selected} onChange={() => toggleSelected(cal)} />
          Sync
        </label>
      </div>
    )
  }

  if (!status.configured) {
    return (
      <div className="set-panel">
        <div className="set-head"><div className="wf-serif set-head-t">Calendars</div></div>
        <div className="set-card" style={{ padding: 22 }}>
          <div className="muted" style={{ fontWeight: 600 }}>
            Google Calendar isn’t configured on the server yet. Set <code>GOOGLE_CLIENT_ID</code>,{' '}
            <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_CALENDAR_REDIRECT_URI</code> and{' '}
            <code>TOKEN_ENCRYPTION_KEY</code> in the server environment, then reload.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Calendars</div>
        {status.connected && (
          <button type="button" className="btn btn-primary" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : '↻ Sync now'}
          </button>
        )}
      </div>

      {syncMsg && <div className="tiny" style={{ fontWeight: 700, margin: '0 2px 12px', color: 'var(--ink, #2b2b2b)' }}>{syncMsg}</div>}

      {!status.connected ? (
        <div className="set-card" style={{ padding: 22 }}>
          <div className="set-row2-t" style={{ marginBottom: 6 }}>Connect a Google account</div>
          <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 16 }}>
            Bring your family’s Google calendars into Waffled. You’ll pick which ones sync and who each one belongs to.
          </div>
          <button type="button" className="btn btn-primary" onClick={connect} disabled={connecting}>
            {connecting ? 'Opening Google…' : 'Connect Google Calendar'}
          </button>
        </div>
      ) : (
        <>
          {status.calendars.length > 6 && (
            <div className="cal-toolbar">
              <input
                className="cal-search"
                placeholder="Search calendars…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="cal-sync" title="Hide calendars that aren’t syncing">
                <input type="checkbox" checked={syncedOnly} onChange={() => setSyncedOnly((v) => !v)} />
                Synced only
              </label>
              <label className="cal-sync" title="Hide read-only subscriptions (holidays, others’ calendars)">
                <input type="checkbox" checked={hideReadOnly} onChange={() => setHideReadOnly((v) => !v)} />
                Hide read-only
              </label>
            </div>
          )}

          {status.accounts.map((acct) => {
            const q = query.trim().toLowerCase()
            const all = status.calendars.filter((c) => c.accountId === acct.id)
            const syncingCount = all.filter((c) => c.selected).length
            const shown = all.filter((c) => {
              if (syncedOnly && !c.selected) return false
              if (hideReadOnly && !c.selected && isReadOnly(c.accessRole)) return false
              if (q && !(c.summary ?? c.googleCalendarId).toLowerCase().includes(q)) return false
              return true
            })
            const open = q ? true : !collapsed[acct.id] // searching forces sections open

            return (
              <div className="set-card cal-acct" key={acct.id}>
                <div
                  className="cal-acct-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => setCollapsed((c) => ({ ...c, [acct.id]: !c[acct.id] }))}
                >
                  <span className="set-ic2">🔗</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="set-row2-t" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {acct.email ?? acct.googleSub}
                    </span>
                    <span className="tiny muted" style={{ fontWeight: 600 }}>
                      {syncingCount} of {all.length} syncing · connected {fmtWhen(acct.connectedAt)}
                    </span>
                  </span>
                  {/* A dead Google sign-in (expired/revoked refresh token) surfaces here
                      with a one-tap Reconnect that re-auths IN PLACE — keeps every
                      calendar→person mapping + ★ write-target (unlike Disconnect). */}
                  {acct.lastSyncError && (
                    <button type="button" className="btn btn-primary cal-reconnect" disabled={connecting} onClick={(e) => { e.stopPropagation(); connect() }}>
                      Reconnect
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); disconnect(acct.id) }}>
                    Disconnect
                  </button>
                  <span className={`cal-chev ${open ? 'open' : ''}`}>›</span>
                </div>
                {acct.lastSyncError && (
                  <div className="cal-acct-error">
                    ⚠ Problem syncing — Google sign-in expired or was revoked. Click <b>Reconnect</b> to fix (your calendar assignments are kept).
                  </div>
                )}

                {open && (
                  <div className="cal-acct-body">
                    <div className="cal-bulk">
                      <button type="button" className="linkbtn" onClick={() => setAll(shown, true)}>Sync all</button>
                      <span className="muted">·</span>
                      <button type="button" className="linkbtn" onClick={() => setAll(shown, false)}>Sync none</button>
                    </div>
                    {shown.length === 0 ? (
                      <div className="muted" style={{ padding: '6px 2px 2px', fontWeight: 600 }}>
                        {all.length === 0 ? 'No calendars on this account.' : 'No calendars match.'}
                      </div>
                    ) : (
                      shown.map((cal) => <CalRow key={cal.id} cal={cal} />)
                    )}
                  </div>
                )}
              </div>
            )
          })}

          <button type="button" className="btn btn-ghost set-add" onClick={connect} disabled={connecting}>
            ＋ Connect another account
          </button>
        </>
      )}
    </div>
  )
}

// Countdowns display preferences (a core Calendar feature). Lives under Calendars.
// Birthday-horizon options: a birthday only surfaces once it's within this many days.
const BIRTHDAY_HORIZON_OPTIONS: { days: number; label: string }[] = [
  { days: 61, label: '2 months' },
  { days: 92, label: '3 months' },
  { days: DEFAULT_BIRTHDAY_HORIZON_DAYS, label: '6 months' },
  { days: 274, label: '9 months' },
  { days: 366, label: 'A year (always show)' },
]

function CountdownsSettings() {
  const { sleeps, birthdayHorizonDays } = useCountdowns()
  const [on, setOn] = useState(sleeps)
  const [horizon, setHorizon] = useState(birthdayHorizonDays)
  useEffect(() => setOn(sleeps), [sleeps])
  useEffect(() => setHorizon(birthdayHorizonDays), [birthdayHorizonDays])
  function toggle(next: boolean) {
    setOn(next)
    countdownsApi.setSleeps(next).catch(() => setOn(!next))
  }
  function pickHorizon(next: number) {
    const prev = horizon
    setHorizon(next)
    countdownsApi.setBirthdayHorizonDays(next).catch(() => setHorizon(prev))
  }
  return (
    <div className="set-card" style={{ marginTop: 18, padding: 22 }}>
      <div className="set-row2-t" style={{ marginBottom: 4 }}>⏳ Countdowns</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 16 }}>
        Count down to trips, birthdays, and anything you flag on the calendar. Add one from the Today “Countdowns” card, or tick “Show a countdown” when editing an event.
      </div>

      <label
        style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', fontWeight: 600 }}
        onClick={(e) => { e.preventDefault(); toggle(!on) }}
      >
        <span className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label="Count in sleeps instead of days" />
        <span>Count in “sleeps” instead of “days” (kid-friendly)</span>
      </label>

      <div style={{ marginTop: 18 }}>
        <div className="set-row2-t" style={{ marginBottom: 4 }}>Show birthdays within</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 10 }}>
          A birthday only appears on the countdown list once it’s this close — so the whole family’s birthdays don’t crowd it a year out.
        </div>
        <select
          className="sel"
          value={horizon}
          aria-label="Show birthdays within"
          onChange={(e) => pickHorizon(Number(e.target.value))}
          style={{ maxWidth: 260 }}
        >
          {BIRTHDAY_HORIZON_OPTIONS.some((o) => o.days === horizon) ? null : (
            <option value={horizon}>{horizon} days</option>
          )}
          {BIRTHDAY_HORIZON_OPTIONS.map((o) => (
            <option key={o.days} value={o.days}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

// Sub-tabs that depend on integrations we haven't built yet render their section
// honestly rather than faking data. (Defended in the build report.)
const PLACEHOLDERS: Record<string, { title: string; note: string }> = {
  chores: { title: 'Chores & rewards', note: 'Reward styles & the reward shop build on the chores ledger (6.1 / 6.4).' },
  meals: { title: 'Meals', note: 'Meal preferences & dietary defaults pair with the Meals screen.' },
  lists: { title: 'Lists', note: 'List defaults & sharing pair with the Lists screen.' },
  display: { title: 'Display & Kiosk', note: 'Brightness & screensaver timing land here. Kiosk device pairing moved to Sign-in & Security.' },
  notifications: { title: 'Notifications', note: 'Push to phones rides APNs + Google reminders (6.7).' },
}

function Placeholder({ tab }: { tab: string }) {
  const p = PLACEHOLDERS[tab]
  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">{p.title}</div>
      </div>
      <div className="set-card" style={{ padding: 22 }}>
        <div className="muted" style={{ fontWeight: 600 }}>{p.note}</div>
      </div>
    </div>
  )
}

// Currency catalog management (the "spend"/economy config). Admin-only writes;
// inline edits save on blur, default/spendable toggle immediately.
function CurrencyRow({ c, canDelete }: { c: Currency; canDelete: boolean }) {
  const [label, setLabel] = useState(c.label)
  const [symbol, setSymbol] = useState(c.symbol ?? '')
  const [confirmDel, setConfirmDel] = useState(false)
  const save = (patch: Record<string, unknown>) => currenciesApi.update(c.id, patch).catch(() => {})
  return (
    <div className="cur-row">
      <input className="cur-sym" value={symbol} maxLength={2} aria-label="Symbol"
        onChange={(e) => setSymbol(e.target.value)} onBlur={() => symbol !== (c.symbol ?? '') && save({ symbol: symbol || null })} />
      <input className="cur-label" value={label} aria-label="Label"
        onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== c.label && save({ label: label.trim() })} />
      <button type="button" className={`cur-flag ${c.isDefault ? 'on' : ''}`} title="Default earn currency"
        onClick={() => !c.isDefault && save({ isDefault: true })}>{c.isDefault ? '★ Default' : 'Make default'}</button>
      <button type="button" className={`cur-flag ${c.spendable ? 'on' : ''}`} title="Can be spent on rewards"
        onClick={() => save({ spendable: !c.spendable })}>{c.spendable ? 'Spendable' : 'Earn-only'}</button>
      {canDelete && !c.isDefault ? (
        <button type="button" className="cur-del" aria-label={`Delete ${c.label}`}
          onClick={() => (confirmDel ? currenciesApi.remove(c.id).catch(() => {}) : setConfirmDel(true))}>
          {confirmDel ? 'Tap to confirm' : '×'}
        </button>
      ) : <span className="cur-del-sp" />}
    </div>
  )
}

// Household reward-approval gate. On (default) → every redemption waits for a parent;
// off → kids redeem instantly with currency they've already earned (a balance guard
// still applies server-side). Optimistic toggle, reverts on failure.
function RewardApprovalCard() {
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    rewardsApi.settings()
      .then((s) => alive && setRequireApproval(s.requireApproval))
      .catch(() => alive && setRequireApproval(true))
    return () => { alive = false }
  }, [])
  async function toggle() {
    if (requireApproval === null || saving) return
    const next = !requireApproval
    setRequireApproval(next)
    setSaving(true)
    try { await rewardsApi.setSettings(next) }
    catch { setRequireApproval(!next) }
    finally { setSaving(false) }
  }
  return (
    <div className="set-card" style={{ padding: 18, marginTop: 14 }}>
      <div className="card-h" style={{ marginBottom: 4 }}>Reward approvals</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
        Sets the default for <b>new</b> rewards. On = a parent OKs the purchase; off = the kid redeems instantly with what they’ve earned. Even if off, each reward can have an override to explicitly require approval.
      </div>
      <SettingRow icon="✅" title="New rewards need a parent’s OK by default"
        sub={requireApproval === false ? 'Off — new rewards are instant unless you switch them on.' : 'On — new rewards wait in the approval queue unless you switch them off.'}>
        <input type="checkbox" className="set-check" checked={requireApproval ?? true}
          disabled={requireApproval === null || saving} onChange={toggle} />
      </SettingRow>
    </div>
  )
}

// Photo-proof retention. Chores can require a photo on completion; those photos are
// throwaway verification, so a daily sweep deletes them N days after the chore is
// settled (the record that a photo existed is kept). 0 = keep until deleted by hand.
const PROOF_TTL_OPTIONS = [
  { v: 1, label: '1 day' },
  { v: 3, label: '3 days' },
  { v: 7, label: '7 days' },
  { v: 30, label: '30 days' },
  { v: 0, label: 'Keep until I delete them' },
]
function ChoreProofCard() {
  const [ttl, setTtl] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  // Loaded for the count on the "View stored photos" button + handed to the drawer
  // so it doesn't refetch; the drawer updates it back through setProofs on delete.
  const [proofs, setProofs] = useState<StoredProof[] | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    let alive = true
    choresApi.getSettings().then((s) => alive && setTtl(s.proofTtlDays)).catch(() => alive && setTtl(3))
    choresApi.listProofs().then((r) => alive && setProofs(r.proofs)).catch(() => alive && setProofs([]))
    return () => { alive = false }
  }, [])
  async function update(next: number) {
    if (ttl === null || saving) return
    const prev = ttl
    setTtl(next)
    setSaving(true)
    try { await choresApi.setProofTtlDays(next) }
    catch { setTtl(prev) }
    finally { setSaving(false) }
  }
  const sub =
    ttl === 0
      ? 'Proof photos are kept until you remove them.'
      : `Proof photos are deleted ${ttl ?? 3} day${(ttl ?? 3) === 1 ? '' : 's'} after a chore is approved.`
  const count = proofs?.length ?? 0
  return (
    <div className="set-card" style={{ padding: 18, marginTop: 14 }}>
      <div className="card-h" style={{ marginBottom: 4 }}>Photo proof</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
        Some chores require a photo to complete. These are quick proof shots, not memories — Waffled deletes them automatically after the chore is settled (a note that a photo was attached stays). Rejected chores’ photos are removed right away.
      </div>
      <SettingRow icon="📸" title="Keep proof photos for" sub={sub}>
        <select className="sel" value={ttl ?? 3} disabled={ttl === null || saving}
          onChange={(e) => update(Number(e.target.value))}>
          {PROOF_TTL_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </SettingRow>
      {count > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="proof-view-btn" onClick={() => setDrawerOpen(true)}>
            View stored photos ({count}) ›
          </button>
        </div>
      )}
      {drawerOpen && (
        <ChoreProofsDrawer proofs={proofs} onChanged={setProofs} onClose={() => setDrawerOpen(false)} />
      )}
    </div>
  )
}

function fmtProofDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Stored proof photos — a slide-over review/delete surface opened from the Photo
// proof card (so it stays off the main settings page). The home for the "keep
// until I delete them" option + early cleanup. Tap a thumbnail to enlarge; delete
// one or clear all. `proofs`/`onChanged` are owned by the parent card.
function ChoreProofsDrawer({
  proofs,
  onChanged,
  onClose,
}: {
  proofs: StoredProof[] | null
  onChanged: (next: StoredProof[]) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [enlarge, setEnlarge] = useState<StoredProof | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const list = proofs ?? []
  const count = list.length
  async function del(id: string) {
    setBusy(id)
    try { await choresApi.deleteProof(id); onChanged(list.filter((x) => x.instanceId !== id)) }
    finally { setBusy(null) }
  }
  async function clearAll() {
    setBusy('all')
    try { await choresApi.clearProofs(); onChanged([]) }
    finally { setBusy(null); setConfirmClear(false) }
  }
  return (
    <>
      <div className="proof-drawer-scrim" onClick={onClose}>
        <div className="proof-drawer" role="dialog" aria-label="Stored proof photos" onClick={(e) => e.stopPropagation()}>
          <div className="proof-drawer-head">
            <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={onClose}>‹ Back</button>
            <div className="wf-serif">Stored proof photos</div>
          </div>
          <div className="proof-drawer-body">
            <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
              Proof photos still on the server. They’re removed automatically per your retention setting — delete any here to clear them sooner.
            </div>
            {proofs === null ? (
              <div className="muted" style={{ fontWeight: 600 }}>Loading…</div>
            ) : count === 0 ? (
              <div className="muted" style={{ fontWeight: 600 }}>No stored proof photos.</div>
            ) : (
              <>
                <div className="proof-grid">
                  {list.map((p) => (
                    <div className="proof-cell" key={p.instanceId}>
                      <button type="button" className="proof-thumb" onClick={() => setEnlarge(p)} title="View larger">
                        {p.proofUrl && <img src={p.proofUrl} alt={`Proof for ${p.choreTitle}`} />}
                      </button>
                      <div className="proof-meta">
                        <div className="proof-title">{p.emoji ? `${p.emoji} ` : ''}{p.choreTitle}</div>
                        <div className="tiny muted">{p.personName ?? '—'}{fmtProofDate(p.completedAt) ? ` · ${fmtProofDate(p.completedAt)}` : ''}</div>
                      </div>
                      <button type="button" className="proof-del" aria-label={`Delete proof for ${p.choreTitle}`} disabled={busy === p.instanceId} onClick={() => del(p.instanceId)}>🗑</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
                  <button type="button" className="pill" disabled={busy === 'all'} onClick={() => setConfirmClear(true)}>Clear all ({count})</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {enlarge && (
        <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={() => setEnlarge(null)}>
          <div className="modal-card chore-proof-modal" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="modal-close" aria-label="Close" onClick={() => setEnlarge(null)}>×</button>
            <div className="cpm-head"><div className="cpm-head-tx">
              <div className="cpm-title">{enlarge.emoji ? `${enlarge.emoji} ` : ''}{enlarge.choreTitle}</div>
              <div className="cpm-sub">{enlarge.personName ?? '—'}{fmtProofDate(enlarge.completedAt) ? ` · ${fmtProofDate(enlarge.completedAt)}` : ''}</div>
            </div></div>
            <div className="cpm-stage">{enlarge.proofUrl && <img src={enlarge.proofUrl} alt={`Proof for ${enlarge.choreTitle}`} />}</div>
            <div className="cpm-actions">
              <button type="button" className="pill" disabled={busy === enlarge.instanceId} onClick={() => { del(enlarge.instanceId); setEnlarge(null) }}>🗑 Delete</button>
            </div>
          </div>
        </div>
      )}
      {confirmClear && (
        <ConfirmDialog title="Delete all proof photos?" message={`This removes all ${count} stored proof photos. The record that a photo was attached stays.`} confirmLabel="Delete all" danger onConfirm={clearAll} onClose={() => setConfirmClear(false)} />
      )}
    </>
  )
}

function RewardsSettingsPanel() {
  const { currencies, loading } = useCurrencies()
  const [newLabel, setNewLabel] = useState('')
  const [newSymbol, setNewSymbol] = useState('')
  const [adding, setAdding] = useState(false)
  async function add() {
    if (!newLabel.trim()) return
    setAdding(true)
    try {
      await currenciesApi.create({ label: newLabel.trim(), symbol: newSymbol.trim() || null })
      setNewLabel(''); setNewSymbol('')
    } finally {
      setAdding(false)
    }
  }
  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Chores &amp; Rewards</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>The currencies your family earns &amp; spends</div>
      </div>
      {/* Economy widget — the currencies a family earns/spends and the trades
          between them belong together, so box them into one tray. */}
      <div className="set-tray">
        <div className="set-card" style={{ padding: 18 }}>
          <div className="card-h" style={{ marginBottom: 4 }}>Currencies</div>
          <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
            Rename stars, add your own, or run several. The <b>default</b> is what new chores award; <b>spendable</b> ones can buy rewards. Set up trades between them under <b>Conversions</b> below.
          </div>
          {loading ? (
            <div className="muted" style={{ fontWeight: 600 }}>Loading…</div>
          ) : (
            currencies.map((c) => <CurrencyRow key={c.id} c={c} canDelete={currencies.length > 1} />)
          )}
          <div className="cur-add">
            <input className="cur-sym" value={newSymbol} maxLength={2} placeholder="⭐" aria-label="New symbol" onChange={(e) => setNewSymbol(e.target.value)} />
            <input className="cur-label" value={newLabel} placeholder="Add a currency (e.g. Family Dollars)" aria-label="New label" onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={adding || !newLabel.trim()} onClick={add}>＋ Add</button>
          </div>
        </div>

        {currencies.length > 1 && <ConversionsSection currencies={currencies} />}
      </div>

      {/* Redemption policy — its own concern, so it sits apart from the economy. */}
      <RewardApprovalCard />

      {/* Chore photo-proof retention; the stored-photo review/delete gallery opens
          in a slide-over from inside this card. */}
      <ChoreProofCard />
    </div>
  )
}

function ConversionsSection({ currencies }: { currencies: Currency[] }) {
  const { conversions } = useConversions()
  const [fromCur, setFromCur] = useState(currencies[0]?.key ?? '')
  const [toCur, setToCur] = useState(currencies[1]?.key ?? '')
  const [fromAmt, setFromAmt] = useState(10)
  const [toAmt, setToAmt] = useState(1)
  const [busy, setBusy] = useState(false)
  const sym = (key: string) => currencies.find((c) => c.key === key)?.symbol ?? '•'
  async function add() {
    if (!fromCur || !toCur || fromCur === toCur) return
    setBusy(true)
    try {
      await conversionsApi.create({ fromCurrency: fromCur, toCurrency: toCur, fromAmount: fromAmt, toAmount: toAmt })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="set-card" style={{ padding: 18, marginTop: 14 }}>
      <div className="card-h" style={{ marginBottom: 4 }}>Conversions</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
        Let the family trade up a tier — e.g. <b>10 ⭐ → 1 💵</b>. Anyone can convert their own balance on the Rewards tab.
      </div>
      {conversions.map((c) => (
        <div key={c.id} className="conv-row">
          <span className="conv-rate">
            {c.fromAmount} {c.from.symbol ?? sym(c.fromCurrency)} {c.from.label ?? c.fromCurrency}
            <span className="conv-arrow">→</span>
            {c.toAmount} {c.to.symbol ?? sym(c.toCurrency)} {c.to.label ?? c.toCurrency}
          </span>
          <button type="button" className="cur-del" aria-label="Delete conversion" onClick={() => conversionsApi.remove(c.id)}>×</button>
        </div>
      ))}
      <div className="conv-add">
        <input type="number" min={1} className="conv-amt" value={fromAmt} onChange={(e) => setFromAmt(Number(e.target.value) || 1)} aria-label="From amount" />
        <select className="conv-cur" value={fromCur} onChange={(e) => setFromCur(e.target.value)} aria-label="From currency">
          {currencies.map((c) => <option key={c.key} value={c.key}>{(c.symbol ? `${c.symbol} ` : '') + c.label}</option>)}
        </select>
        <span className="conv-arrow">→</span>
        <input type="number" min={1} className="conv-amt" value={toAmt} onChange={(e) => setToAmt(Number(e.target.value) || 1)} aria-label="To amount" />
        <select className="conv-cur" value={toCur} onChange={(e) => setToCur(e.target.value)} aria-label="To currency">
          {currencies.map((c) => <option key={c.key} value={c.key}>{(c.symbol ? `${c.symbol} ` : '') + c.label}</option>)}
        </select>
        <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0 }} disabled={busy || fromCur === toCur} onClick={add}>＋ Add</button>
      </div>
    </div>
  )
}

// Sign out — clears the local session (and revokes the refresh token server-side),
// which fires waffled:auth-changed and drops the kiosk back to the Login screen.
// Tap-to-confirm so a stray touch on the wall-mounted kiosk doesn't sign everyone out.
function SignOutButton({ className }: { className?: string }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  async function signOut() {
    if (!confirm) { setConfirm(true); return }
    setBusy(true)
    try {
      await authApi.logout()
    } catch {
      setBusy(false) // logout already clears the local session on its own; only reset if it threw before that
    }
  }
  return (
    <button type="button" className={className ?? 'btn btn-ghost'} onClick={signOut} disabled={busy}>
      {busy ? 'Signing out…' : confirm ? 'Tap again to sign out' : '⏻ Sign out'}
    </button>
  )
}

// About / account — what this Waffled is, plus the sign-out control. Replaces the old
// placeholder now that real auth exists.
// A pill toggle switch (replaces the bare checkbox for on/off settings).
function Switch({ checked, disabled, onChange, ariaLabel }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`set-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="set-switch-knob" />
    </button>
  )
}

// Enable/disable optional modules for this household. Available modules use a live
// toggle and, when on, reveal their own settings; planned ones show "Coming soon".
function ModulesPanel() {
  const { household } = useHousehold()
  const [saving, setSaving] = useState<string | null>(null)

  async function toggle(key: string, on: boolean) {
    setSaving(key)
    try {
      await personsApi.setModules({ [key]: on })
      emitHouseholdChanged() // refresh household settings everywhere
    } catch {
      /* ignore — the switch reverts on the next household refetch */
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="wf-serif set-head-t">Modules</div>
        <div className="set-head-sub">Optional features for your household — turn on just what you want.</div>
      </div>
      <div className="set-modules">
        {MODULES.map((m) => {
          const available = m.status === 'available'
          const on = available && moduleEnabled(household, m.key)
          return (
            <div key={m.key} className={`set-module${on ? ' on' : ''}`}>
              <div className="set-module-row">
                <div className="set-module-ic">{m.icon}</div>
                <div className="set-module-main">
                  <div className="set-module-name">{m.name}</div>
                  <div className="set-module-desc">{m.description}</div>
                </div>
                {available ? (
                  <Switch checked={on} disabled={saving === m.key} onChange={(v) => toggle(m.key, v)} ariaLabel={`Enable ${m.name}`} />
                ) : (
                  <span className="set-module-soon">Coming soon</span>
                )}
              </div>
              {on && m.hasSettings && m.key === 'pantry' && <PantrySettings />}
              {on && m.hasSettings && m.key === 'chores' && <ChoresModuleSettings />}
              {on && m.hasSettings && m.key === 'familyNight' && <FamilyNightSettings />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Pantry's own settings (shown when the module is on): the Today-card toggle and
// the editable location list. Saves immediately; refreshes household so Today reacts.
function PantrySettings() {
  const { locations, showOnToday, avoidAllergens, lowThreshold, locationIcons, staleMonths, loading } = usePantry()
  const [list, setList] = useState<string[]>([])
  const [adding, setAdding] = useState('')
  const [show, setShow] = useState(true)
  const [avoid, setAvoid] = useState<string[]>([])
  const [low, setLow] = useState('1')
  const [stale, setStale] = useState('6')
  const [icons, setIcons] = useState<Record<string, string>>({})
  useEffect(() => { if (!loading) { setList(locations); setShow(showOnToday); setAvoid(avoidAllergens); setLow(String(lowThreshold)); setStale(String(staleMonths)); setIcons(locationIcons) } }, [loading, locations, showOnToday, avoidAllergens, lowThreshold, staleMonths, locationIcons])

  async function commitLocations(next: string[]) {
    setList(next)
    try { await pantryApi.setConfig({ locations: next.filter((x) => x.trim()) }); emitHouseholdChanged() } catch { /* ignore */ }
  }
  async function toggleShow(v: boolean) {
    setShow(v)
    try { await pantryApi.setConfig({ showOnToday: v }); emitHouseholdChanged() } catch { /* ignore */ }
  }
  async function toggleAvoid(key: string) {
    const next = avoid.includes(key) ? avoid.filter((a) => a !== key) : [...avoid, key]
    setAvoid(next)
    try { await pantryApi.setConfig({ avoidAllergens: next }); emitHouseholdChanged() } catch { /* ignore */ }
  }
  async function commitLow(v: string) {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return
    try { await pantryApi.setConfig({ lowThreshold: n }); emitHouseholdChanged() } catch { /* ignore */ }
  }
  async function commitStale(v: string) {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < 1 || n > 60) return
    try { await pantryApi.setConfig({ staleMonths: n }); emitHouseholdChanged() } catch { /* ignore */ }
  }
  async function commitIcon(loc: string, emoji: string) {
    const next = { ...icons, [loc]: emoji.trim() }
    if (!emoji.trim()) delete next[loc]
    setIcons(next)
    try { await pantryApi.setConfig({ locationIcons: next }); emitHouseholdChanged() } catch { /* ignore */ }
  }

  if (loading) return null
  return (
    <div className="set-module-settings">
      <div className="set-module-setrow">
        <span>Show a card on Today</span>
        <Switch checked={show} onChange={toggleShow} ariaLabel="Show pantry on Today" />
      </div>
      <div className="set-module-setrow">
        <span>Running low at (or below)</span>
        <input type="number" min="0" step="any" className="pl-low-input" value={low}
          onChange={(e) => setLow(e.target.value)} onBlur={() => commitLow(low)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitLow(low) }} aria-label="Running low threshold" />
      </div>
      <div className="set-module-desc" style={{ marginBottom: 4 }}>
        Default for all items; set a per-item override in the item editor’s “Warn below”.
      </div>
      <div className="set-module-setrow">
        <span>Flag items older than (months)</span>
        <input type="number" min="1" max="60" className="pl-low-input" value={stale}
          onChange={(e) => setStale(e.target.value)} onBlur={() => commitStale(stale)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitStale(stale) }} aria-label="Old item threshold (months)" />
      </div>
      <div className="set-module-desc" style={{ marginBottom: 4 }}>
        Items on hand longer than this get a 🕰️ age badge and a “Been a while” group.
      </div>
      <div className="set-module-setlabel">Allergens to avoid</div>
      <div className="set-module-desc" style={{ marginBottom: 8 }}>
        Items containing these (from Open Food Facts) get a red warning — e.g. a gluten-free home.
      </div>
      <div className="pl-allergen-pick">
        {ALLERGEN_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`pl-allergen-chip${avoid.includes(key) ? ' on' : ''}`}
            aria-pressed={avoid.includes(key)}
            onClick={() => toggleAvoid(key)}
          >
            {ALLERGEN_LABELS[key]}
          </button>
        ))}
      </div>
      <div className="set-module-setlabel">Locations</div>
      <div className="pantry-loc-list">
        {list.map((l, i) => (
          <div className="pantry-loc-row" key={i}>
            <input
              className="pl-loc-icon"
              value={icons[l] ?? ''}
              placeholder="📦"
              maxLength={4}
              aria-label={`Icon for ${l}`}
              onChange={(e) => setIcons((m) => ({ ...m, [l]: e.target.value }))}
              onBlur={() => commitIcon(l, icons[l] ?? '')}
            />
            <input
              value={l}
              onChange={(e) => setList((ls) => ls.map((x, j) => (j === i ? e.target.value : x)))}
              onBlur={() => commitLocations(list)}
            />
            <button type="button" aria-label={`Remove ${l}`} onClick={() => commitLocations(list.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
      </div>
      <div className="pantry-loc-add">
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add a location…"
          onKeyDown={(e) => { if (e.key === 'Enter' && adding.trim()) { commitLocations([...list, adding.trim()]); setAdding('') } }}
        />
        <button type="button" className="pill" disabled={!adding.trim()} onClick={() => { commitLocations([...list, adding.trim()]); setAdding('') }}>Add</button>
      </div>
    </div>
  )
}

// Chores module sub-settings (shown when the module is on): the rewards sub-toggle.
// Rewards is the spend half of the chores economy, so it lives here rather than as
// its own module — it can't be on without chores. Saves immediately; refreshes the
// household so the Tasks "Rewards" tab and the profile jar/redemption cards react.
function ChoresModuleSettings() {
  const [rewards, setRewards] = useState<boolean | null>(null)
  useEffect(() => { choresApi.getSettings().then((s) => setRewards(s.rewards)).catch(() => setRewards(true)) }, [])
  async function toggle(v: boolean) {
    setRewards(v)
    try { await choresApi.setRewardsEnabled(v); emitHouseholdChanged() } catch { /* reverts on next refetch */ }
  }
  if (rewards === null) return null
  return (
    <div className="set-module-settings">
      <div className="set-module-setrow">
        <span>Rewards (star shop &amp; redemptions)</span>
        <Switch checked={rewards} onChange={toggle} ariaLabel="Enable rewards" />
      </div>
      <div className="set-module-desc" style={{ marginTop: 6 }}>
        Kids spend earned stars on a reward shop. Turn off for chores without a points economy.
      </div>
    </div>
  )
}

// Family Night's own settings (shown when the module is on): when it happens, the
// agenda parts (rotating roles), and whether it's on the calendar. Admin-only panel.
const FN_DAYS = [0, 1, 2, 3, 4, 5, 6]
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'part'

function FamilyNightSettings() {
  const { view, loading } = useFamilyNight()
  const [parts, setParts] = useState<FamilyNightPart[] | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (view) setParts(view.config.parts) }, [view])
  if (loading || !view || !parts) return null
  const config = view.config
  const onCalendar = !!config.eventId

  async function save(patch: Parameters<typeof familyNightApi.setConfig>[0]) {
    setSaving(true)
    try { await familyNightApi.setConfig(patch) } finally { setSaving(false) }
  }

  function editPart(i: number, patch: Partial<FamilyNightPart>) {
    setParts((ps) => (ps ? ps.map((p, j) => (j === i ? { ...p, ...patch } : p)) : ps))
  }
  function addPart() { setParts((ps) => [...(ps ?? []), { id: `part${Date.now()}`, label: 'New part', emoji: '⭐', rotates: true }]) }
  function removePart(i: number) { setParts((ps) => (ps ? ps.filter((_, j) => j !== i) : ps)) }
  async function saveParts() {
    const clean = (parts ?? []).map((p) => ({ ...p, id: p.id || slug(p.label), label: p.label.trim() || 'Part' })).filter((p) => p.label)
    if (!clean.length) return
    await save({ parts: clean })
  }

  async function toggleCalendar(v: boolean) {
    setSaving(true)
    try { if (v) await familyNightApi.schedule(); else await familyNightApi.unschedule() } finally { setSaving(false) }
  }

  return (
    <div className="set-module-settings">
      <div className="set-module-setrow">
        <span>Happens on</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="sel" value={config.dayOfWeek} disabled={saving} onChange={(e) => save({ dayOfWeek: Number(e.target.value) })}>
            {FN_DAYS.map((d) => <option key={d} value={d}>{weekdayName(d)}</option>)}
          </select>
          <input className="set-inline-input" type="time" value={config.time} disabled={saving} onChange={(e) => save({ time: e.target.value })} style={{ width: 120 }} />
        </div>
      </div>

      <div className="set-module-setrow">
        <span>Show on the Today page</span>
        <Switch checked={config.showOnToday !== false} disabled={saving} onChange={(v) => save({ showOnToday: v })} ariaLabel="Show Family Night on Today" />
      </div>

      <div className="set-module-setrow">
        <span>Show on the calendar</span>
        <Switch checked={onCalendar} disabled={saving} onChange={toggleCalendar} ariaLabel="Show Family Night on the calendar" />
      </div>
      <div className="set-module-desc" style={{ marginTop: -4, marginBottom: 8 }}>
        Adds a weekly “🏡 Family Night” event to the family calendar (syncs to Google if that calendar is connected). Changing the day or time re-schedules it.
      </div>

      <div className="set-row2-t" style={{ marginTop: 6, marginBottom: 4 }}>Agenda parts</div>
      <div className="set-module-desc" style={{ marginBottom: 8 }}>
        Roles that rotate among family members each week. Turn off “Rotate” for a part someone always does.
      </div>
      {parts.map((p, i) => (
        <div key={i} className="fn-part-edit">
          <input className="fn-part-emoji" value={p.emoji} maxLength={4} onChange={(e) => editPart(i, { emoji: e.target.value })} aria-label="Emoji" />
          <input className="fn-part-label" value={p.label} onChange={(e) => editPart(i, { label: e.target.value })} aria-label="Part name" />
          <label className="fn-part-rot"><input type="checkbox" checked={p.rotates} onChange={(e) => editPart(i, { rotates: e.target.checked })} /> Rotate</label>
          <button type="button" className="fn-part-x" aria-label={`Remove ${p.label}`} onClick={() => removePart(i)}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="pill" onClick={addPart}>+ Add part</button>
        <button type="button" className="pill primary" disabled={saving} onClick={saveParts} style={{ marginLeft: 'auto' }}>Save agenda</button>
      </div>
    </div>
  )
}

function AboutPanel() {
  const { household } = useHousehold()
  return (
    <div className="set-panel">
      <div className="set-head"><div className="wf-serif set-head-t">About</div></div>
      <div className="set-card" style={{ padding: 22 }}>
        <div className="set-row2-t" style={{ marginBottom: 4 }}>Waffled — Family Hub</div>
        <div className="tiny muted" style={{ fontWeight: 600 }}>
          Self-hosted{household?.name ? ` · ${household.name}` : ''}. Version and storage info land here.
        </div>
      </div>
      <div className="set-card" style={{ marginTop: 18, padding: 22 }}>
        <div className="set-row2-t" style={{ marginBottom: 4 }}>Account</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 16 }}>
          Sign this kiosk out to switch to another family member's account.
        </div>
        <SignOutButton className="btn btn-primary" />
      </div>
    </div>
  )
}

// Households — switch between the households this account belongs to, and accept
// pending invitations. Not admin-gated: any account can switch / accept. Switching
// mints a fresh session for the other membership and does a full reload so the app
// (and PowerSync) re-establish cleanly against the new household.
function HouseholdsPanel() {
  const { household, memberships, pendingInvites } = useHousehold()
  const [switching, setSwitching] = useState<string | null>(null)
  const [accepting, setAccepting] = useState<string | null>(null)

  async function doSwitch(id: string) {
    setSwitching(id)
    try {
      await authApi.switchHousehold(id)
      window.location.assign('/')
    } catch {
      setSwitching(null)
    }
  }
  async function doAccept(id: string) {
    setAccepting(id)
    try {
      await authApi.acceptInvite(id)
      emitHouseholdChanged()
    } finally {
      setAccepting(null)
    }
  }

  const soloAndNoInvites = memberships.length <= 1 && pendingInvites.length === 0

  return (
    <div className="set-panel">
      <div className="set-head"><div className="wf-serif set-head-t">Households</div></div>
      <div className="set-card" style={{ padding: 22 }}>
        <div className="set-row2-t" style={{ marginBottom: 4 }}>Your households</div>
        <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 16 }}>
          {soloAndNoInvites
            ? 'You belong to one household. Invitations to join others will show up here.'
            : 'Switch between the households you belong to. Switching reloads Waffled for that family.'}
        </div>
        {memberships.map((m) => {
          const current = m.householdId === household?.id
          return (
            <div key={m.householdId} className="set-row2" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <div className="set-row2-t">{m.householdName}</div>
              {current ? (
                <span className="tiny muted" style={{ fontWeight: 700 }}>Current</span>
              ) : (
                <button type="button" className="btn btn-primary" disabled={switching === m.householdId} onClick={() => doSwitch(m.householdId)}>
                  {switching === m.householdId ? 'Switching…' : 'Switch'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {pendingInvites.length > 0 && (
        <div className="set-card" style={{ marginTop: 18, padding: 22 }}>
          <div className="set-row2-t" style={{ marginBottom: 4 }}>Pending invitations</div>
          <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 16 }}>
            Accept an invitation to join another household. It then appears above.
          </div>
          {pendingInvites.map((inv) => (
            <div key={inv.id} className="set-row2" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <div className="set-row2-t">{inv.householdName}</div>
              <button type="button" className="btn btn-primary" disabled={accepting === inv.id} onClick={() => doAccept(inv.id)}>
                {accepting === inv.id ? 'Accepting…' : 'Accept'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Login & security (admin only) — attach an OIDC/SSO provider and decide whether
// password login stays on. Immich-style: config lives in the DB, edited here. The
// client secret is write-only (server returns only whether one is set).
function SecurityPanel() {
  const [cfg, setCfg] = useState<OidcConfig | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [issuer, setIssuer] = useState('')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('') // blank = keep existing
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState('')
  const [pwEnabled, setPwEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null)

  function hydrate(c: OidcConfig) {
    setCfg(c)
    setEnabled(c.oidcEnabled)
    setIssuer(c.issuerUrl ?? '')
    setClientId(c.clientId ?? '')
    setLabel(c.buttonLabel)
    setScopes(c.scopes)
    setPwEnabled(c.passwordLoginEnabled)
    setSecret('')
  }
  useEffect(() => {
    authApi.getConfig().then(hydrate).catch(() => setForbidden(true))
  }, [])

  if (forbidden) return <div className="set-panel"><div className="set-head"><div className="wf-serif set-head-t">Sign-in &amp; Security</div></div><div className="set-card" style={{ padding: 22 }}><div className="muted" style={{ fontWeight: 600 }}>Only an admin can manage sign-in settings.</div></div></div>
  if (!cfg) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>

  async function test() {
    setTestMsg(null)
    setBusy(true)
    try {
      const r = await authApi.testConfig(issuer.trim())
      setTestMsg(r.ok ? { ok: true, text: `Connected — ${r.issuer}` } : { ok: false, text: r.message || 'Could not reach the provider.' })
    } catch {
      setTestMsg({ ok: false, text: 'Could not reach the provider.' })
    } finally {
      setBusy(false)
    }
  }

  async function save(patch: OidcConfigPatch) {
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      await authApi.saveConfig(patch)
      const fresh = await authApi.getConfig()
      hydrate(fresh)
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch {
      setError('Could not save. Check the issuer, client ID and secret — and that the server has TOKEN_ENCRYPTION_KEY set.')
    } finally {
      setBusy(false)
    }
  }

  const saveOidc = () =>
    save({
      oidcEnabled: enabled,
      issuerUrl: issuer.trim() || null,
      clientId: clientId.trim() || null,
      buttonLabel: label.trim() || 'Sign in with SSO',
      scopes: scopes.trim() || 'openid email profile',
      ...(secret ? { clientSecret: secret } : {}),
    })

  const canDisablePw = cfg.oidcEnabled // server requires OIDC usable; mirror loosely here

  return (
    <div className="set-panel">
      <div className="set-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div className="wf-serif set-head-t">Sign-in &amp; Security</div>
        {saved && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
      </div>

      {!cfg.encryptionAvailable && (
        <div className="set-card" style={{ padding: 18, marginBottom: 16 }}>
          <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary, #e0653f)' }}>
            Set <code>TOKEN_ENCRYPTION_KEY</code> in the server environment to store the OIDC client secret securely. OIDC can't be enabled until then.
          </div>
        </div>
      )}

      <div className="set-card" style={{ padding: 18 }}>
        <SettingRow icon="🔐" title="Single sign-on (OIDC)" sub="Let family members sign in through your identity provider (Authentik, Keycloak, Google, …).">
          <input type="checkbox" className="set-check" checked={enabled} disabled={!cfg.encryptionAvailable} onChange={(e) => setEnabled(e.target.checked)} />
        </SettingRow>

        <div className="sec-form">
          <label className="auth-label">Issuer URL</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="set-inline-input" style={{ flex: 1, width: 'auto' }} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.example.com/application/o/waffled/" />
            <button type="button" className="btn btn-ghost" onClick={test} disabled={busy || !issuer.trim()}>Test</button>
          </div>
          {testMsg && <div className="tiny" style={{ fontWeight: 700, marginTop: 6, color: testMsg.ok ? 'var(--good, #2e7d32)' : 'var(--primary, #e0653f)' }}>{testMsg.text}</div>}

          <label className="auth-label">Client ID</label>
          <input className="set-inline-input" style={{ width: '100%' }} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="waffled" />

          <label className="auth-label">Client secret</label>
          <input className="set-inline-input" style={{ width: '100%' }} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.secretSet ? '•••••••• (leave blank to keep)' : 'Paste the client secret'} />

          <label className="auth-label">Button label</label>
          <input className="set-inline-input" style={{ width: '100%' }} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sign in with SSO" />

          <label className="auth-label">Scopes</label>
          <input className="set-inline-input" style={{ width: '100%' }} value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="openid email profile" />

          <div className="tiny muted" style={{ fontWeight: 600, marginTop: 10 }}>
            Redirect URI to register at your provider: <code>{window.location.origin}/api/auth/oidc/callback</code>. Sign-in is invite-only — the provider's verified email must already belong to a family member.
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button type="button" className="btn btn-primary" style={{ marginTop: 14 }} onClick={saveOidc} disabled={busy}>Save SSO settings</button>
        </div>
      </div>

      <div className="set-card" style={{ marginTop: 16 }}>
        <SettingRow icon="🔑" title="Password login" sub={canDisablePw ? 'Turn off to require everyone to use SSO.' : 'Enable & save SSO before you can turn this off.'}>
          <input
            type="checkbox"
            className="set-check"
            checked={pwEnabled}
            disabled={!canDisablePw && pwEnabled}
            onChange={(e) => { setPwEnabled(e.target.checked); save({ passwordLoginEnabled: e.target.checked }) }}
          />
        </SettingRow>
      </div>

      <KioskDevicesSection />
    </div>
  )
}

// Kiosk devices — lives inside Sign-in & Security (all auth/session config in one
// place). Pair tablets as shared kiosks, rename/revoke them, and nudge admins to set
// a PIN (an admin without one can be claimed by anyone tapping their tile). Uses the
// in-app ConfirmDialog, never native popups.
function KioskDevicesSection() {
  const { members } = useHouseholdSettings()
  const [devices, setDevices] = useState<KioskDevice[] | null>(null)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [dialog, setDialog] = useState<{ kind: 'remove' | 'promote' | 'rename'; device?: KioskDevice } | null>(null)

  const load = () => kioskApi.devices().then(setDevices).catch(() => setErr('Only an admin can manage devices.'))
  useEffect(() => { load() }, [])

  const adminsNoPin = members.filter((m) => m.isAdmin && !m.hasPin)

  async function genCode() {
    setBusy(true)
    setNote(null)
    setCopied(false)
    try { setCode(await kioskApi.createPairingCode()) } catch { setErr('Could not create a code.') } finally { setBusy(false) }
  }

  async function copyCode() {
    if (!code) return
    try { await navigator.clipboard.writeText(code.code); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard blocked */ }
  }

  // While a code is shown, poll for the device pairing so the admin sees it land
  // without a manual refresh. The new device appearing = the code was used.
  useEffect(() => {
    if (!code) return
    const baseline = devices?.length ?? 0
    const id = setInterval(async () => {
      try {
        const list = await kioskApi.devices()
        setDevices(list)
        if (list.length > baseline) {
          const newest = list[list.length - 1]
          setNote(`✓ “${newest?.label ?? 'A device'}” just paired.`)
          setCode(null)
          clearInterval(id)
        }
      } catch { /* keep polling */ }
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  async function runDialog(value?: string) {
    const d = dialog
    if (!d) return
    try {
      if (d.kind === 'promote') {
        const id = await kioskApi.promote()
        setNote('This device is now a kiosk — use “Switch” in the rail to reach the picker.')
        load()
        // Chain straight into naming the new device.
        setDialog({ kind: 'rename', device: { id, label: 'Kiosk', lastSeenAt: null, createdAt: '' } })
        return
      }
      if (d.kind === 'remove' && d.device) await kioskApi.revokeDevice(d.device.id)
      else if (d.kind === 'rename' && d.device && value) await kioskApi.renameDevice(d.device.id, value)
      load()
      setDialog(null)
    } catch {
      setErr('That action didn’t work.')
      setDialog(null)
    }
  }

  return (
    <div className="set-card" style={{ marginTop: 16, padding: 18 }}>
      <div className="card-h" style={{ marginBottom: 4 }}>Kiosk devices</div>
      <div className="tiny muted" style={{ fontWeight: 600, marginBottom: 14 }}>
        Turn a tablet into a shared family display with a profile picker. Pair it from here, or set up the tablet itself with a code.
      </div>

      {adminsNoPin.length > 0 && (
        <div className="set-card" style={{ padding: 14, marginBottom: 14, borderLeft: '3px solid var(--primary, #e0653f)' }}>
          <div className="set-row2-t" style={{ marginBottom: 4 }}>⚠️ Set a PIN for your admins</div>
          <div className="tiny muted" style={{ fontWeight: 600 }}>
            On a shared kiosk, anyone can tap an admin profile with no PIN and gain full control.
            Add a PIN for {adminsNoPin.map((m) => m.name).join(', ')} in Family &amp; People.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'promote' })}>Use this device as a kiosk</button>
        <button type="button" className="btn btn-ghost" onClick={genCode} disabled={busy}>
          {busy ? 'Generating…' : 'Generate pairing code'}
        </button>
      </div>
      {note && <div className="tiny" style={{ fontWeight: 700, color: 'var(--good, #2e7d32)', marginTop: 10 }}>{note}</div>}
      {code && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="kp-code kp-code-sel">{code.code}</span>
            <button type="button" className="btn btn-ghost" onClick={copyCode}>{copied ? '✓ Copied' : 'Copy'}</button>
            <span className="tiny muted" style={{ fontWeight: 600 }}>Waiting for a device to pair…</span>
          </div>
          <div className="tiny muted" style={{ fontWeight: 600, marginTop: 8 }}>
            On the new tablet: open this Waffled’s address → “Set up this device as a kiosk” → enter this code. One-time, expires in ~10 minutes.
          </div>
        </div>
      )}
      {err && <div className="auth-error" style={{ marginTop: 12 }}>{err}</div>}

      <div style={{ marginTop: 16 }}>
        <div className="set-row2-t" style={{ margin: '2px 2px 4px' }}>Paired devices</div>
        {devices === null ? (
          <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 2px' }}>Loading…</div>
        ) : devices.length === 0 ? (
          <div className="tiny muted" style={{ fontWeight: 600, padding: '8px 2px' }}>No kiosks paired yet.</div>
        ) : (
          devices.map((d) => (
            <SettingRow key={d.id} icon="🖥️" title={d.label} sub={`Last seen ${fmtWhen(d.lastSeenAt)} · paired ${fmtWhen(d.createdAt)}`}>
              <button type="button" className="linkbtn" onClick={() => setDialog({ kind: 'rename', device: d })}>Rename</button>
              <button type="button" className="linkbtn" style={{ color: 'var(--primary)' }} onClick={() => setDialog({ kind: 'remove', device: d })}>Remove</button>
            </SettingRow>
          ))
        )}
      </div>

      {dialog?.kind === 'promote' && (
        <ConfirmDialog
          title="Use this device as a kiosk?"
          message="After you switch profiles or sign out, this device will show the family profile picker."
          confirmLabel="Use as kiosk"
          onConfirm={runDialog}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && dialog.device && (
        <ConfirmDialog
          title={`Remove “${dialog.device.label}”?`}
          message="It will need to be paired again to act as a kiosk."
          confirmLabel="Remove"
          danger
          onConfirm={runDialog}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && dialog.device && (
        <ConfirmDialog
          title="Rename device"
          confirmLabel="Save"
          input={{ label: 'Device name', placeholder: 'Kitchen', initial: dialog.device.label }}
          onConfirm={runDialog}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

// Display & Kiosk: a per-device "this is the family display" toggle (enables the
// screensaver + keep-awake locally) plus household-wide screensaver settings.
const CONTENT_OPTS: Array<{ key: DisplayConfig['content']; label: string }> = [
  { key: 'photos', label: 'Photos + clock' },
  { key: 'clock', label: 'Clock & weather' },
  { key: 'off', label: 'Off' },
]
const PHOTO_SOURCE_OPTS: Array<{ key: DisplayConfig['photoSource']; label: string }> = [
  { key: 'all', label: 'All photos' },
  { key: 'favorites', label: 'Favorites only' },
  { key: 'album', label: 'Specific album' },
]
const INTERVAL_OPTS = [5, 10, 20, 30]
function DisplayKioskPanel() {
  const paired = isKioskMode()
  const [displayOn, setDisplayOn] = useState(isDisplayMode())
  const [cfg, setCfg] = useState<DisplayConfig | null>(null)
  const [error, setError] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [preview, setPreview] = useState(false)
  const dirtyRef = useRef(false)
  // Live data for the instant preview (and what the real screensaver uses).
  const wx = useWeather()
  const { events } = useEventsToday()
  const { photos } = usePhotos()
  const { household } = useHousehold()
  const nextEvent = events.find((e) => new Date(e.startsAt).getTime() > Date.now()) ?? null
  // Distinct album names (a photo's `memory`), for the "Specific album" picker.
  const albums = useMemo(
    () => [...new Set(photos.map((p) => p.memory).filter((m): m is string => !!m))],
    [photos],
  )

  useEffect(() => {
    kioskApi.displayConfig().then((c) => { setCfg(c); setError(false) }).catch(() => setError(true))
  }, [])

  function update(patch: Partial<DisplayConfig>) {
    setCfg((c) => (c ? { ...c, ...patch } : c))
    dirtyRef.current = true
  }
  function updateDim(patch: Partial<DisplayConfig['nightDim']>) {
    setCfg((c) => (c ? { ...c, nightDim: { ...c.nightDim, ...patch } } : c))
    dirtyRef.current = true
  }

  // Debounced auto-save (like MealsPanel) — echoing the server's normalized cfg back
  // into state must not retrigger a save, hence dirtyRef.
  useEffect(() => {
    if (!cfg || !dirtyRef.current) return
    const t = setTimeout(async () => {
      try {
        const s = await kioskApi.setDisplayConfig(cfg)
        dirtyRef.current = false
        setCfg(s)
        // Let a display layer running in THIS browser reload immediately.
        window.dispatchEvent(new Event('waffled:display-changed'))
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1800)
      } catch {
        setError(true)
      }
    }, 600)
    return () => clearTimeout(t)
  }, [cfg])

  function toggleDisplay() {
    const next = !displayOn
    setDisplayMode(next)
    setDisplayOn(next)
  }

  return (
    <div className="set-panel">
      <div className="set-head" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div className="wf-serif set-head-t">Display &amp; Kiosk</div>
        {savedFlash && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved</span>}
        <span className="tiny muted" style={{ marginLeft: 'auto', fontWeight: 600 }}>Screensaver settings save automatically</span>
      </div>

      <div className="set-card">
        <SettingRow icon="🖥️" title="Use this browser as the family display" sub={paired ? 'On — this device is paired as a kiosk.' : 'This device only. Enables the screensaver & keeps the screen awake.'}>
          <input type="checkbox" className="set-check" checked={displayOn} disabled={paired} onChange={toggleDisplay} />
        </SettingRow>
        {!displayOn && (
          <div className="tiny muted" style={{ padding: '0 16px 14px', fontWeight: 600 }}>
            The screensaver, keep-awake and reset-to-Today below only run on a browser that’s set as the display. Turn this on to test them here.
          </div>
        )}
      </div>

      {error && <div className="set-card" style={{ padding: 18, marginTop: 16 }}><div className="muted" style={{ fontWeight: 600 }}>Couldn’t load display settings.</div></div>}
      {cfg && (
        <>
          <div className="set-card" style={{ marginTop: 16 }}>
            <div className="flabel" style={{ padding: '14px 16px 4px' }}>SCREENSAVER</div>
            <SettingRow icon="🌅" title="Screensaver after" sub="Minutes of inactivity before the screensaver appears.">
              <input type="number" min={1} max={120} className="set-inline-input" style={{ width: 80 }} value={cfg.screensaverMinutes} onChange={(e) => update({ screensaverMinutes: Number(e.target.value) || 1 })} />
            </SettingRow>
            <div className="set-row2">
              <div className="set-ic2">🖼️</div>
              <div style={{ flex: 1 }}>
                <div className="set-row2-t">What it shows</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>“Photos + clock” is a photo slideshow with the clock, weather &amp; next event overlaid. Photos need a signed-in profile; the picker always shows the clock.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="seg" style={{ width: 'fit-content' }}>
                  {CONTENT_OPTS.map((o) => (
                    <button type="button" key={o.key} className={cfg.content === o.key ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => update({ content: o.key })}>{o.label}</button>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost" disabled={cfg.content === 'off'} onClick={() => setPreview(true)}>Preview</button>
              </div>
            </div>
            <SettingRow icon="🔒" title="Return to profile picker afterward" sub="When the screensaver wakes on a paired kiosk, drop to the profile picker.">
              <input type="checkbox" className="set-check" checked={cfg.returnToPicker} onChange={(e) => update({ returnToPicker: e.target.checked })} />
            </SettingRow>

            {cfg.content === 'photos' && (
              <>
                <div className="set-row2">
                  <div className="set-ic2">📷</div>
                  <div style={{ flex: 1 }}>
                    <div className="set-row2-t">Photo source</div>
                    <div className="tiny muted" style={{ fontWeight: 600 }}>Which photos the slideshow plays.</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <div className="seg" style={{ width: 'fit-content' }}>
                      {PHOTO_SOURCE_OPTS.map((o) => (
                        <button
                          type="button"
                          key={o.key}
                          className={cfg.photoSource === o.key ? 'on' : ''}
                          style={{ cursor: o.key === 'album' && albums.length === 0 ? 'not-allowed' : 'pointer' }}
                          disabled={o.key === 'album' && albums.length === 0}
                          title={o.key === 'album' && albums.length === 0 ? 'No albums yet — group photos into a memory first.' : undefined}
                          onClick={() => update({ photoSource: o.key })}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    {cfg.photoSource === 'album' && albums.length > 0 && (
                      <select
                        className="set-inline-input"
                        value={cfg.photoAlbum ?? ''}
                        onChange={(e) => update({ photoAlbum: e.target.value || null })}
                      >
                        <option value="">Choose an album…</option>
                        {albums.map((a) => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                <SettingRow icon="⏱️" title="Transition speed" sub="Seconds each photo stays on screen.">
                  <select
                    className="set-inline-input"
                    style={{ width: 110 }}
                    value={cfg.photoInterval}
                    onChange={(e) => update({ photoInterval: Number(e.target.value) || 10 })}
                  >
                    {INTERVAL_OPTS.map((s) => (
                      <option key={s} value={s}>{s} seconds</option>
                    ))}
                  </select>
                </SettingRow>

                <SettingRow icon="🔀" title="Shuffle photos" sub="Play the photos in a random order.">
                  <input type="checkbox" className="set-check" checked={cfg.photoShuffle} onChange={(e) => update({ photoShuffle: e.target.checked })} />
                </SettingRow>
              </>
            )}
          </div>

          <div className="set-card" style={{ marginTop: 16 }}>
            <SettingRow icon="🏠" title="Return to Today when idle" sub="Minutes before an idle screen resets to the dashboard (0 = never).">
              <input type="number" min={0} max={60} className="set-inline-input" style={{ width: 80 }} value={cfg.resetHomeMinutes} onChange={(e) => update({ resetHomeMinutes: Math.max(0, Number(e.target.value) || 0) })} />
            </SettingRow>
          </div>

          <div className="set-card" style={{ marginTop: 16 }}>
            <SettingRow icon="🌙" title="Night dimming" sub="Dim the display on a schedule (overnight).">
              <input type="checkbox" className="set-check" checked={cfg.nightDim.enabled} onChange={(e) => updateDim({ enabled: e.target.checked })} />
            </SettingRow>
            {cfg.nightDim.enabled && (
              <SettingRow icon="🕙" title="Dim from → to">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="time" className="set-inline-input" value={cfg.nightDim.start} onChange={(e) => updateDim({ start: e.target.value })} />
                  <span className="muted">→</span>
                  <input type="time" className="set-inline-input" value={cfg.nightDim.end} onChange={(e) => updateDim({ end: e.target.value })} />
                </div>
              </SettingRow>
            )}
          </div>
        </>
      )}

      {preview && cfg && cfg.content !== 'off' && (
        <Screensaver
          content={cfg.content === 'photos' ? 'photos' : 'clock'}
          photos={screensaverPhotos(photos, cfg)}
          weather={wx}
          nextEvent={nextEvent}
          timezone={household?.timezone}
          intervalSeconds={cfg.photoInterval}
          onWake={() => setPreview(false)}
        />
      )}
    </div>
  )
}

export function Settings() {
  const { household, person, memberships, pendingInvites } = useHousehold()
  // Tab lives in the URL (?tab=) so a refresh returns to where you were.
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'family'
  const setTab = (key: string) => setParams({ tab: key }, { replace: true })

  // Your own account, for the self-service Account panels. Only a real personal
  // login has one (hasAccount) — the shared kiosk and login-less members don't, so
  // the My Profile / My Account items stay hidden for them. Fetched once, like
  // memberships; while it loads the items are simply absent (then appear).
  const [account, setAccount] = useState<AccountInfo | null>(null)
  useEffect(() => {
    let alive = true
    accountApi.get().then((a) => alive && setAccount(a)).catch(() => alive && setAccount(null))
    return () => { alive = false }
  }, [])

  // Wait until we know who's signed in, so admins don't flash the trimmed nav.
  if (!household) return <div className="settings-screen"><div className="set-content"><div className="muted" style={{ padding: 20 }}>Loading…</div></div></div>

  // Non-admins only see what they can actually use (About + Sign out). Admin-only
  // tabs are hidden rather than shown-then-blocked, so there's nothing to fumble.
  const isAdmin = person?.isAdmin ?? false
  // The households tab only appears when there's something to act on (another
  // membership to switch to, or a pending invite). Not admin-gated.
  const showHouseholds = memberships.length > 1 || pendingInvites.length > 0
  // The self-service Account items appear only for a real personal login — never on
  // the shared kiosk, never for a login-less member.
  const showAccount = !isKioskMode() && !!account?.hasAccount
  const nav = NAV.filter((n) => (!n.admin || isAdmin) && (n.key !== 'households' || showHouseholds) && ((n.key !== 'profile' && n.key !== 'account') || showAccount))
  const activeTab = nav.some((n) => n.key === tab) ? tab : (nav[0]?.key ?? 'about')

  return (
    <div className="settings-screen">
      <div className="set-nav">
        <div className="flabel" style={{ margin: '2px 2px 8px' }}>SETTINGS</div>
        {nav.map((n, i) => {
          const header = NAV_GROUP_LABELS[n.group] && n.group !== nav[i - 1]?.group ? NAV_GROUP_LABELS[n.group] : null
          return (
            <Fragment key={n.key}>
              {header && <div className="set-navgroup">{header}</div>}
              <button type="button" className={`set-navitem ${activeTab === n.key ? 'on' : ''}`} onClick={() => setTab(n.key)}>
                <span className="set-navic">{n.icon}</span>
                {n.label}
              </button>
            </Fragment>
          )
        })}
        <div className="set-nav-foot">
          <SignOutButton className="set-navitem set-signout" />
        </div>
      </div>
      <div className="set-content">
        {activeTab === 'profile' ? <MyProfilePanel /> : activeTab === 'account' ? <MyAccountPanel /> : activeTab === 'family' ? <FamilyPanel /> : activeTab === 'ai' ? <AiPanel /> : activeTab === 'calendars' ? <><CalendarsPanel /><CountdownsSettings /></> : activeTab === 'meals' ? <MealsPanel /> : activeTab === 'chores' ? <RewardsSettingsPanel /> : activeTab === 'security' ? <SecurityPanel /> : activeTab === 'display' ? <DisplayKioskPanel /> : activeTab === 'health' ? <SystemHealthPanel /> : activeTab === 'modules' ? <ModulesPanel /> : activeTab === 'apikeys' ? <ApiKeysPanel /> : activeTab === 'households' ? <HouseholdsPanel /> : activeTab === 'about' ? <AboutPanel /> : <Placeholder tab={activeTab} />}
      </div>
    </div>
  )
}
