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
  const [inviteNote, setInviteNote] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

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
              <Toggle on={form.isAdmin} onClick={() => set('isAdmin', !form.isAdmin)} />
            </div>
            <div className="set-row" style={{ padding: '12px 0', borderTop: '1px solid var(--hair-2)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Show on kiosk</div>
                <div className="tiny muted" style={{ fontWeight: 600 }}>Appears on the family display</div>
              </div>
              <Toggle on={form.showOnKiosk} onClick={() => set('showOnKiosk', !form.showOnKiosk)} />
            </div>
          </div>

          {editing && (
            <div className="set-card" style={{ padding: '2px 16px', marginBottom: 14 }}>
              <div className="set-row" style={{ padding: '13px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 21, width: 30, textAlign: 'center', flex: 'none' }}>🔑</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Account</div>
                  <div className="tiny muted" style={{ fontWeight: 600 }}>
                    {person!.hasLogin ? 'Signed in with their own account' : person!.memberType === 'kid' ? 'Managed by parents' : 'No login yet'}
                  </div>
                </div>
                {person!.hasLogin ? (
                  <span className="tiny" style={{ fontWeight: 700, color: 'var(--wally)' }}>Connected ✓</span>
                ) : person!.memberType === 'kid' ? (
                  <span className="tiny muted" style={{ fontWeight: 700 }}>Parental</span>
                ) : (
                  <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setInviteNote(true)}>Invite to sign in</button>
                )}
              </div>
              {inviteNote && (
                <div className="tiny muted" style={{ fontWeight: 600, padding: '0 0 12px', lineHeight: 1.45 }}>
                  Sign-in invites arrive with Google / Apple login (M5). For now {form.name || 'they'} stays {person!.memberType === 'kid' ? 'parent-managed' : 'without a login'} — the account link will activate here once auth is connected.
                </div>
              )}
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || saving} style={{ width: '100%', justifyContent: 'center' }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add person'}
          </button>
        </form>

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
