import { useEffect, useState } from 'react'
import { personsApi, captureApi, calendarsApi, usePersons, useHouseholdSettings, emitHouseholdChanged, type SettingsMember, type CaptureConfig, type Provider, type CalendarStatus, type CalendarLink } from '../lib/api'
import { PersonModal } from './components/PersonModal'
import '../styles/settings.css'

const NAV = [
  { key: 'family', icon: '👨‍👩‍👧‍👦', label: 'Family & people' },
  { key: 'ai', icon: '✨', label: 'AI & capture' },
  { key: 'accounts', icon: '🔗', label: 'Accounts' },
  { key: 'calendars', icon: '📅', label: 'Calendars' },
  { key: 'chores', icon: '⭐', label: 'Chores & rewards' },
  { key: 'meals', icon: '🍽️', label: 'Meals' },
  { key: 'lists', icon: '📝', label: 'Lists' },
  { key: 'display', icon: '🖥️', label: 'Display & kiosk' },
  { key: 'notifications', icon: '🔔', label: 'Notifications' },
  { key: 'about', icon: 'ℹ️', label: 'About' },
]

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

function FamilyPanel() {
  const { household, members, loading, error, refetch } = useHouseholdSettings()
  const [editing, setEditing] = useState<SettingsMember | null>(null)
  const [adding, setAdding] = useState(false)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [locDraft, setLocDraft] = useState<string | null>(null)

  if (loading) return <div className="muted" style={{ padding: 20 }}>Loading…</div>
  if (error || !household) return <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to manage your family.</div>

  async function saveHousehold(patch: Record<string, unknown>) {
    await personsApi.updateHousehold(patch)
    emitHouseholdChanged() // refresh the topbar clock/name immediately
    refetch()
  }

  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="nk-serif set-head-t">Family &amp; people</div>
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

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Sign this kiosk in to manage AI.</div></div>
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
        <div className="nk-serif set-head-t">AI &amp; capture</div>
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
// toggle which ones Nook syncs, and pull events on demand. Connect navigates to
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
  const [hideReadOnly, setHideReadOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  function load() {
    calendarsApi
      .calendarStatus()
      .then((s) => { setStatus(s); setLoading(false); setError(false) })
      .catch(() => { setError(true); setLoading(false) })
  }
  useEffect(load, [])

  if (loading) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Loading…</div></div>
  if (error || !status) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Sign this kiosk in to manage calendars.</div></div>

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
          </div>
        </div>
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
        <label className="cal-sync" title="Sync this calendar into Nook">
          <input type="checkbox" checked={cal.selected} onChange={() => toggleSelected(cal)} />
          Sync
        </label>
      </div>
    )
  }

  if (!status.configured) {
    return (
      <div className="set-panel">
        <div className="set-head"><div className="nk-serif set-head-t">Calendars</div></div>
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
        <div className="nk-serif set-head-t">Calendars</div>
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
            Bring your family’s Google calendars into Nook. You’ll pick which ones sync and who each one belongs to.
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
                  <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); disconnect(acct.id) }}>
                    Disconnect
                  </button>
                  <span className={`cal-chev ${open ? 'open' : ''}`}>›</span>
                </div>

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

// Sub-tabs that depend on integrations we haven't built yet render their section
// honestly rather than faking data. (Defended in the build report.)
const PLACEHOLDERS: Record<string, { title: string; note: string }> = {
  accounts: { title: 'Accounts', note: 'Google / Apple sign-in and account linking land with auth (M3.3 / M5).' },
  chores: { title: 'Chores & rewards', note: 'Reward styles & the reward shop build on the chores ledger (6.1 / 6.4).' },
  meals: { title: 'Meals', note: 'Meal preferences & dietary defaults pair with the Meals screen.' },
  lists: { title: 'Lists', note: 'List defaults & sharing pair with the Lists screen.' },
  display: { title: 'Display & kiosk', note: 'Brightness, screensaver timing & device pairing land with kiosk pairing (3.3).' },
  notifications: { title: 'Notifications', note: 'Push to phones rides APNs + Google reminders (6.7).' },
  about: { title: 'About', note: 'Nook — Family Hub. Self-hosted. Version and storage info land here.' },
}

function Placeholder({ tab }: { tab: string }) {
  const p = PLACEHOLDERS[tab]
  return (
    <div className="set-panel">
      <div className="set-head">
        <div className="nk-serif set-head-t">{p.title}</div>
      </div>
      <div className="set-card" style={{ padding: 22 }}>
        <div className="muted" style={{ fontWeight: 600 }}>{p.note}</div>
      </div>
    </div>
  )
}

export function Settings() {
  const [tab, setTab] = useState('family')
  return (
    <div className="settings-screen">
      <div className="set-nav">
        <div className="flabel" style={{ margin: '2px 2px 8px' }}>SETTINGS</div>
        {NAV.map((n) => (
          <button type="button" key={n.key} className={`set-navitem ${tab === n.key ? 'on' : ''}`} onClick={() => setTab(n.key)}>
            <span className="set-navic">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </div>
      <div className="set-content">
        {tab === 'family' ? <FamilyPanel /> : tab === 'ai' ? <AiPanel /> : tab === 'calendars' ? <CalendarsPanel /> : <Placeholder tab={tab} />}
      </div>
    </div>
  )
}
