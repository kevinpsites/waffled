import { useState, type FormEvent } from 'react'
import { personsApi, type SettingsMember } from '../../lib/api'

const SWATCHES = ['#2F7FED', '#EC6049', '#25A368', '#8B5CF6', '#E0A500', '#EC4899', '#14B8A6', '#6B7280']
const MEMBER_TYPES = [
  { key: 'adult', label: 'Adult' },
  { key: 'teen', label: 'Teen' },
  { key: 'kid', label: 'Kid' },
]

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} role="switch" aria-checked={on} style={{ width: 44, height: 26, borderRadius: 999, flex: 'none', cursor: 'pointer', background: on ? 'var(--wally)' : 'var(--hair)', position: 'relative', transition: 'background .15s' }}>
      <div style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: 999, background: '#fff', transition: 'left .15s' }} />
    </div>
  )
}

// Add or edit a family member.
export function PersonModal({ person, onClose, onSaved }: { person: SettingsMember | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!person
  const [form, setForm] = useState({
    name: person?.name ?? '',
    memberType: person?.memberType ?? 'kid',
    avatarEmoji: person?.avatarEmoji ?? '🙂',
    colorHex: person?.colorHex ?? SWATCHES[0],
    birthday: person?.birthday ? String(person.birthday).slice(0, 10) : '',
    isAdmin: person?.isAdmin ?? false,
    showOnKiosk: person?.showOnKiosk ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  // Admin + kiosk visibility apply the instant you flip them when editing — they
  // don't wait on the "Save changes" button. Otherwise toggling Admin and then
  // saving the Login card (its own button) would quietly discard the admin change.
  // For a brand-new person there's no id yet, so we just stage it until create.
  async function toggleField(k: 'isAdmin' | 'showOnKiosk') {
    const next = !form[k]
    set(k, next)
    if (!editing) return
    try {
      await personsApi.updatePerson(person!.id, { [k]: next })
      onSaved()
    } catch {
      set(k, !next) // revert on failure
    }
  }

  // Login management (admin). A login is an email (enables invite-gated SSO) plus
  // an optional password. Driven by local state so status updates without reopening.
  const [loginEmail, setLoginEmail] = useState(person?.loginEmail ?? '')
  const [loginPw, setLoginPw] = useState('')
  const [hasLoginLocal, setHasLoginLocal] = useState(!!person?.loginEmail)
  const [hasPasswordLocal, setHasPasswordLocal] = useState(person?.hasPassword ?? false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginErr, setLoginErr] = useState<string | null>(null)
  const [loginSaved, setLoginSaved] = useState(false)
  const [confirmRemoveLogin, setConfirmRemoveLogin] = useState(false)

  async function saveLogin() {
    const email = loginEmail.trim()
    if (!email || loginBusy) return
    if (loginPw && loginPw.length < 8) { setLoginErr('Password must be at least 8 characters.'); return }
    setLoginBusy(true); setLoginErr(null); setLoginSaved(false)
    try {
      await personsApi.setLogin(person!.id, { email, ...(loginPw ? { password: loginPw } : {}) })
      if (loginPw) setHasPasswordLocal(true)
      setHasLoginLocal(true)
      setLoginPw('')
      setLoginSaved(true)
      setTimeout(() => setLoginSaved(false), 1800)
      onSaved()
    } catch {
      setLoginErr('Could not save — that email may already be in use.')
    } finally {
      setLoginBusy(false)
    }
  }

  async function removeLogin() {
    if (!confirmRemoveLogin) { setConfirmRemoveLogin(true); return }
    setLoginBusy(true); setLoginErr(null)
    try {
      await personsApi.removeLogin(person!.id)
      setLoginEmail(''); setLoginPw(''); setHasLoginLocal(false); setHasPasswordLocal(false)
      onSaved()
    } catch {
      setLoginErr('Could not remove the login.')
    } finally {
      setLoginBusy(false); setConfirmRemoveLogin(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || saving) return
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      memberType: form.memberType,
      avatarEmoji: form.avatarEmoji.trim() || null,
      colorHex: form.colorHex,
      birthday: form.birthday || null,
      isAdmin: form.isAdmin,
      showOnKiosk: form.showOnKiosk,
    }
    try {
      if (editing) await personsApi.updatePerson(person!.id, payload)
      else await personsApi.createPerson(payload)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function del() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await personsApi.deletePerson(person!.id)
    onSaved()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 14 }}>{editing ? 'Edit person' : 'Add a person'}</div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Name</span>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Wally" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Avatar</span>
              <input value={form.avatarEmoji} onChange={(e) => set('avatarEmoji', e.target.value)} placeholder="🐢" maxLength={4} />
            </label>
          </div>

          <div className="field">
            <span>Member type</span>
            <div className="seg" style={{ width: 'fit-content' }}>
              {MEMBER_TYPES.map((t) => (
                <button type="button" key={t.key} className={form.memberType === t.key ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => set('memberType', t.key)}>{t.label}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Color</span>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              {SWATCHES.map((c) => (
                <button type="button" key={c} aria-label={`color ${c}`} onClick={() => set('colorHex', c)} style={{ width: 30, height: 30, borderRadius: 999, background: c, border: form.colorHex === c ? '3px solid var(--ink)' : '2px solid #fff', boxShadow: '0 0 0 1px var(--hair)', cursor: 'pointer' }} />
              ))}
            </div>
          </div>

          <label className="field">
            <span>Birthday (optional)</span>
            <input type="date" value={form.birthday} onChange={(e) => set('birthday', e.target.value)} />
          </label>

          <div className="set-card" style={{ padding: '2px 16px', marginBottom: 14 }}>
            <div className="set-row" style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Admin (full management)</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>Can add people, edit settings</div>
              </div>
              <Toggle on={form.isAdmin} onClick={() => toggleField('isAdmin')} />
            </div>
            <div className="set-row" style={{ padding: '12px 0', borderTop: '1px solid var(--hair-2)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Show on kiosk</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>Appears on the family display</div>
              </div>
              <Toggle on={form.showOnKiosk} onClick={() => toggleField('showOnKiosk')} />
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || saving} style={{ width: '100%', justifyContent: 'center' }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add person'}
          </button>
        </form>

        {/* Login lives below "Save changes" with its own buttons — and outside the
            form so pressing Enter in these fields doesn't trigger the profile save. */}
        {editing && (
          <div className="set-card" style={{ padding: 16, marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: hasLoginLocal ? 12 : 8 }}>
              <div style={{ fontSize: 21, width: 30, textAlign: 'center', flex: 'none' }}>🔑</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Login</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>
                  {!hasLoginLocal
                    ? 'No login yet — give them an email to sign in.'
                    : hasPasswordLocal
                      ? 'Can sign in with their email & password'
                      : 'Invited to sign in via SSO (no password set)'}
                </div>
              </div>
              {loginSaved && <span className="tiny" style={{ fontWeight: 700, color: 'var(--good, #2e7d32)' }}>✓ Saved</span>}
            </div>

            <label className="field" style={{ marginBottom: 8 }}>
              <span>Email</span>
              <input type="email" autoComplete="off" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="name@example.com" />
            </label>
            <label className="field" style={{ marginBottom: 8 }}>
              <span>{hasPasswordLocal ? 'New password (leave blank to keep)' : 'Password (optional — blank invites SSO only)'}</span>
              <input type="password" autoComplete="new-password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} placeholder={hasPasswordLocal ? '••••••••' : 'At least 8 characters'} />
            </label>
            {loginErr && <div className="tiny" style={{ fontWeight: 700, color: 'var(--primary)', marginBottom: 8 }}>{loginErr}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="pill btn-primary" style={{ color: '#fff', border: 0, cursor: 'pointer' }} disabled={loginBusy || !loginEmail.trim()} onClick={saveLogin}>
                {loginBusy ? 'Saving…' : hasLoginLocal ? 'Update login' : 'Give a login'}
              </button>
              {hasLoginLocal && !person!.isOwner && (
                <button type="button" onClick={removeLogin} style={{ border: 0, background: 'none', color: confirmRemoveLogin ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  {confirmRemoveLogin ? 'Tap again to remove login' : 'Remove login'}
                </button>
              )}
            </div>
          </div>
        )}

        {editing && !person!.isOwner && (
          <button type="button" onClick={del} style={{ display: 'block', margin: '14px auto 0', border: 0, background: 'none', color: confirmDelete ? 'var(--primary)' : 'var(--ink-3)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            {confirmDelete ? 'Tap again to remove this person' : 'Remove person'}
          </button>
        )}
        {editing && person!.isOwner && (
          <div className="tiny muted" style={{ textAlign: 'center', marginTop: 12, fontWeight: 600 }}>The household owner can’t be removed.</div>
        )}
      </div>
    </div>
  )
}
