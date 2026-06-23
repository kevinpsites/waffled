import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { personsApi, captureApi, calendarsApi, mealsApi, currenciesApi, conversionsApi, rewardsApi, goalCalendarApi, groceryApi, authApi, kioskApi, isDisplayMode, setDisplayMode, isKioskMode, usePersons, useCurrencies, useConversions, useHousehold, useHouseholdSettings, useWeather, useEventsToday, usePhotos, emitHouseholdChanged, type SettingsMember, type CaptureConfig, type Provider, type CalendarStatus, type CalendarLink, type MealCalendarSettings, type Currency, type MemoryGroup, type PantryStaple, type OidcConfig, type OidcConfigPatch, type KioskDevice, type DisplayConfig } from '../lib/api'
import { PersonModal } from './components/PersonModal'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Screensaver, screensaverPhotos } from './components/Screensaver'
import '../styles/settings.css'

// `admin` tabs are only shown to admins — non-admins can't change those settings,
// so we don't show options they can't use (they still get About + Sign out).
const NAV = [
  { key: 'family', icon: '👨‍👩‍👧‍👦', label: 'Family & People', admin: true },
  { key: 'ai', icon: '✨', label: 'AI & Capture', admin: true },
  { key: 'security', icon: '🔐', label: 'Sign-in & Security', admin: true },
  { key: 'calendars', icon: '📅', label: 'Calendars', admin: true },
  { key: 'chores', icon: '⭐', label: 'Chores & Rewards', admin: true },
  { key: 'meals', icon: '🍽️', label: 'Meals', admin: true },
  { key: 'lists', icon: '📝', label: 'Lists', admin: true },
  { key: 'display', icon: '🖥️', label: 'Display & Kiosk', admin: true },
  { key: 'notifications', icon: '🔔', label: 'Notifications', admin: true },
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
        <div className="nk-serif set-head-t">Family &amp; People</div>
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
        Words Nook has learned to link to a goal, from the events you’ve linked. Remove any that look wrong.
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
        <div className="nk-serif set-head-t">AI &amp; Capture</div>
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

  if (error) return <div className="set-panel"><div className="muted" style={{ padding: 20 }}>Sign this kiosk in to manage meal settings.</div></div>
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
        <div className="nk-serif set-head-t">Meals</div>
        {savedFlash && <span className="tiny" style={{ color: 'var(--good, #2e7d32)', fontWeight: 700 }}>✓ Saved · meals updated</span>}
        <span className="tiny muted" style={{ marginLeft: 'auto', fontWeight: 600 }}>Changes save automatically</span>
      </div>

      <div className="set-card">
        <SettingRow icon="📅" title="Add planned meals to the calendar" sub="Each meal you plan shows on the Nook calendar, linked to its recipe.">
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
        <div className="nk-serif set-head-t">{p.title}</div>
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
        <div className="nk-serif set-head-t">Chores &amp; Rewards</div>
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
// which fires nook:auth-changed and drops the kiosk back to the Login screen.
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

// About / account — what this Nook is, plus the sign-out control. Replaces the old
// placeholder now that real auth exists.
function AboutPanel() {
  const { household } = useHousehold()
  return (
    <div className="set-panel">
      <div className="set-head"><div className="nk-serif set-head-t">About</div></div>
      <div className="set-card" style={{ padding: 22 }}>
        <div className="set-row2-t" style={{ marginBottom: 4 }}>Nook — Family Hub</div>
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

  if (forbidden) return <div className="set-panel"><div className="set-head"><div className="nk-serif set-head-t">Sign-in &amp; Security</div></div><div className="set-card" style={{ padding: 22 }}><div className="muted" style={{ fontWeight: 600 }}>Only an admin can manage sign-in settings.</div></div></div>
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
        <div className="nk-serif set-head-t">Sign-in &amp; Security</div>
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
            <input className="set-inline-input" style={{ flex: 1, width: 'auto' }} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.example.com/application/o/nook/" />
            <button type="button" className="btn btn-ghost" onClick={test} disabled={busy || !issuer.trim()}>Test</button>
          </div>
          {testMsg && <div className="tiny" style={{ fontWeight: 700, marginTop: 6, color: testMsg.ok ? 'var(--good, #2e7d32)' : 'var(--primary, #e0653f)' }}>{testMsg.text}</div>}

          <label className="auth-label">Client ID</label>
          <input className="set-inline-input" style={{ width: '100%' }} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="nook" />

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
            On the new tablet: open this Nook’s address → “Set up this device as a kiosk” → enter this code. One-time, expires in ~10 minutes.
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
        window.dispatchEvent(new Event('nook:display-changed'))
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
        <div className="nk-serif set-head-t">Display &amp; Kiosk</div>
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
  const { household, person } = useHousehold()
  // Tab lives in the URL (?tab=) so a refresh returns to where you were.
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'family'
  const setTab = (key: string) => setParams({ tab: key }, { replace: true })

  // Wait until we know who's signed in, so admins don't flash the trimmed nav.
  if (!household) return <div className="settings-screen"><div className="set-content"><div className="muted" style={{ padding: 20 }}>Loading…</div></div></div>

  // Non-admins only see what they can actually use (About + Sign out). Admin-only
  // tabs are hidden rather than shown-then-blocked, so there's nothing to fumble.
  const isAdmin = person?.isAdmin ?? false
  const nav = NAV.filter((n) => !n.admin || isAdmin)
  const activeTab = nav.some((n) => n.key === tab) ? tab : (nav[0]?.key ?? 'about')

  return (
    <div className="settings-screen">
      <div className="set-nav">
        <div className="flabel" style={{ margin: '2px 2px 8px' }}>SETTINGS</div>
        {nav.map((n) => (
          <button type="button" key={n.key} className={`set-navitem ${activeTab === n.key ? 'on' : ''}`} onClick={() => setTab(n.key)}>
            <span className="set-navic">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="set-nav-foot">
          <SignOutButton className="set-navitem set-signout" />
        </div>
      </div>
      <div className="set-content">
        {activeTab === 'family' ? <FamilyPanel /> : activeTab === 'ai' ? <AiPanel /> : activeTab === 'calendars' ? <CalendarsPanel /> : activeTab === 'meals' ? <MealsPanel /> : activeTab === 'chores' ? <RewardsSettingsPanel /> : activeTab === 'security' ? <SecurityPanel /> : activeTab === 'display' ? <DisplayKioskPanel /> : activeTab === 'about' ? <AboutPanel /> : <Placeholder tab={activeTab} />}
      </div>
    </div>
  )
}
