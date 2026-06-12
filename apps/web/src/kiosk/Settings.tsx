import { useEffect, useState } from 'react'
import { personsApi, captureApi, useHouseholdSettings, emitHouseholdChanged, type SettingsMember, type CaptureConfig, type Provider } from '../lib/api'
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

// Sub-tabs that depend on integrations we haven't built yet render their section
// honestly rather than faking data. (Defended in the build report.)
const PLACEHOLDERS: Record<string, { title: string; note: string }> = {
  accounts: { title: 'Accounts', note: 'Google / Apple sign-in and account linking land with auth (M3.3 / M5).' },
  calendars: { title: 'Calendars', note: 'Per-person Google Calendar mapping lands with calendar sync (M5).' },
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
        {tab === 'family' ? <FamilyPanel /> : tab === 'ai' ? <AiPanel /> : <Placeholder tab={tab} />}
      </div>
    </div>
  )
}
