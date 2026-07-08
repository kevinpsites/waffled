import { useState, type FormEvent } from 'react'
import { api, usePersons, useCurrencies, localToday } from '../../lib/api'

export interface ChoreDraft {
  id: string
  title: string
  emoji: string | null
  personId: string | null
  rewardAmount: number | null
  rewardCurrency?: string | null
  rrule?: string | null
  dueTime?: string | null
  requiresApproval?: boolean
  requiresPhoto?: boolean
}

const DAYS: Array<[string, string]> = [
  ['MO', 'Mon'], ['TU', 'Tue'], ['WE', 'Wed'], ['TH', 'Thu'], ['FR', 'Fri'], ['SA', 'Sat'], ['SU', 'Sun'],
]

type Freq = 'once' | 'daily' | 'weekly'

function parseRrule(rrule: string | null | undefined, editing: boolean): { freq: Freq; days: string[] } {
  if (rrule && /FREQ=WEEKLY/i.test(rrule)) {
    const m = rrule.match(/BYDAY=([A-Z,]+)/i)
    return { freq: 'weekly', days: m ? m[1].toUpperCase().split(',') : [] }
  }
  if (rrule && /FREQ=DAILY/i.test(rrule)) return { freq: 'daily', days: [] }
  // No rrule: an existing chore with null rrule is a one-off; a brand-new chore
  // still defaults to "Every day" (the common case).
  return { freq: editing ? 'once' : 'daily', days: [] }
}

function buildRrule(freq: Freq, days: string[]): string | null {
  if (freq === 'once') return null // one-off — no recurrence
  if (freq === 'weekly' && days.length) {
    const sorted = DAYS.map((d) => d[0]).filter((d) => days.includes(d))
    return `FREQ=WEEKLY;BYDAY=${sorted.join(',')}`
  }
  return 'FREQ=DAILY'
}

function initialForm(chore?: ChoreDraft, personId?: string | null, canAssignOthers = true, selfPersonId?: string | null) {
  const sched = parseRrule(chore?.rrule, !!chore)
  // Restricted users (no chore.manage) can only target themselves or up-for-grabs;
  // default them to self rather than the full-list default.
  const prefill = chore?.personId ?? personId ?? (canAssignOthers ? '' : selfPersonId ?? '')
  return {
    title: chore?.title ?? '',
    emoji: chore?.emoji ?? '',
    personId: prefill,
    rewardAmount: chore?.rewardAmount ?? 1,
    rewardCurrency: chore?.rewardCurrency ?? '',
    freq: sched.freq,
    days: sched.days,
    // One-off (freq === 'once') only: which day the single task lands on. New
    // one-offs default to today; editing can't move an already-materialized one.
    dueOn: localToday(),
    // Optional time-of-day the chore is due (HH:MM). Applies to one-offs and each
    // recurring occurrence; empty = no specific time.
    dueTime: (chore?.dueTime ?? '').slice(0, 5),
    requiresApproval: chore?.requiresApproval ?? false,
    requiresPhoto: chore?.requiresPhoto ?? false,
  }
}

// Create (optional `personId` prefill) or edit (`chore`) a chore definition.
export function ChoreModal({
  chore,
  personId,
  canAssignOthers = true,
  selfPersonId,
  onClose,
  onSaved,
}: {
  chore?: ChoreDraft
  personId?: string | null
  // Without chore.manage, restrict the assignee picker to self + up-for-grabs.
  canAssignOthers?: boolean
  selfPersonId?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!chore
  const { persons } = usePersons()
  const { currencies, defaultCurrency } = useCurrencies()
  const [form, setForm] = useState(() => initialForm(chore, personId, canAssignOthers, selfPersonId))
  // Restricted users see only themselves; everyone else sees the full member list.
  const pickable = canAssignOthers ? persons : persons.filter((p) => p.id === selfPersonId)
  // A parent doesn't need another parent's OK: hide the approval toggle when the
  // chore is assigned to an adult/admin. Still shown for kids, teens, and
  // "up for grabs" (unknown claimer), where a sign-off makes sense.
  const assignee = persons.find((p) => p.id === form.personId)
  const assigneeIsAdult = !!assignee && (assignee.memberType === 'adult' || assignee.isAdmin)
  const curKey = form.rewardCurrency || defaultCurrency?.key || 'stars'
  const selectedCur = currencies.find((c) => c.key === curKey)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaving(true)
    const payload = {
      title: form.title.trim(),
      emoji: form.emoji.trim() || null,
      personId: form.personId || null,
      rewardAmount: Number(form.rewardAmount) || 0,
      rewardCurrency: curKey,
      rrule: buildRrule(form.freq, form.days),
      dueTime: form.dueTime || null,
      // Approval is meaningless for an adult assignee — never persist it there.
      requiresApproval: assigneeIsAdult ? false : form.requiresApproval,
      requiresPhoto: form.requiresPhoto,
    }
    try {
      if (editing) await api.updateChore(chore!.id, payload)
      // On create, a one-off also carries its due date (where its single instance
      // lands). Editing can't move an already-materialized one-off's date.
      else await api.createChore(form.freq === 'once' ? { ...payload, dueOn: form.dueOn } : payload)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  async function del() {
    if (!editing || saving) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setSaving(true)
    try {
      await api.deleteChore(chore!.id)
      onSaved()
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <div className="wf-serif" style={{ fontSize: 22, fontWeight: 600, marginBottom: 14 }}>
          {editing ? 'Edit chore' : 'New chore'}
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label className="field" style={{ flex: 3 }}>
              <span>Title</span>
              <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Feed the dog" autoFocus />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Emoji</span>
              <input value={form.emoji} onChange={(e) => set('emoji', e.target.value)} placeholder="🐶" maxLength={4} />
            </label>
          </div>

          <div className="field" style={{ marginBottom: 10 }}>
            <span>Repeats</span>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button type="button" className={form.freq === 'once' ? 'on' : ''} onClick={() => set('freq', 'once')}>Just once</button>
              <button type="button" className={form.freq === 'daily' ? 'on' : ''} onClick={() => set('freq', 'daily')}>Every day</button>
              <button type="button" className={form.freq === 'weekly' ? 'on' : ''} onClick={() => set('freq', 'weekly')}>Certain days</button>
            </div>
            {form.freq === 'weekly' && (
              <div className="chore-days">
                {DAYS.map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    className={`chore-day ${form.days.includes(code) ? 'on' : ''}`}
                    onClick={() => set('days', form.days.includes(code) ? form.days.filter((d) => d !== code) : [...form.days, code])}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {/* One-off: pick the day (today by default). Only on create — an
                existing one-off's instance is already on the calendar. It also
                carries forward until done unless rollover is turned off. */}
            {form.freq === 'once' && !editing && (
              <label className="field" style={{ marginTop: 8 }}>
                <span>On</span>
                <input type="date" min={localToday()} value={form.dueOn} onChange={(e) => set('dueOn', e.target.value || localToday())} />
              </label>
            )}
          </div>

          <label className="field" style={{ marginBottom: 10 }}>
            <span>Due time <span className="tiny muted" style={{ fontWeight: 400 }}>· optional</span></span>
            <input type="time" value={form.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Who</span>
              <select value={form.personId} onChange={(e) => set('personId', e.target.value)}>
                <option value="">— up for grabs —</option>
                {pickable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.avatarEmoji ? `${p.avatarEmoji} ` : ''}
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{selectedCur?.label ?? 'Stars'}</span>
              <input
                type="number"
                min={0}
                value={form.rewardAmount}
                onChange={(e) => set('rewardAmount', Number(e.target.value))}
              />
            </label>
          </div>

          {/* currency picker — only when the family runs more than one currency */}
          {currencies.length > 1 && (
            <div className="field" style={{ marginBottom: 10 }}>
              <span>Currency</span>
              <div className="rw-cur-pick">
                {currencies.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={`rw-cur-chip ${c.key === curKey ? 'on' : ''}`}
                    style={c.key === curKey && c.color ? { borderColor: c.color, color: c.color, background: `${c.color}18` } : undefined}
                    onClick={() => set('rewardCurrency', c.key)}
                  >
                    {c.symbol ?? '⭐'} {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!assigneeIsAdult && (
            <button
              type="button"
              className={`chore-approval ${form.requiresApproval ? 'on' : ''}`}
              onClick={() => set('requiresApproval', !form.requiresApproval)}
            >
              <span className="chore-approval-check" aria-hidden>{form.requiresApproval ? '✓' : ''}</span>
              <span>
                <span className="chore-approval-t">Needs a parent’s OK</span>
                <span className="chore-approval-s">Stars are awarded only after a parent approves.</span>
              </span>
            </button>
          )}

          <button
            type="button"
            className={`chore-approval ${form.requiresPhoto ? 'on' : ''}`}
            onClick={() => set('requiresPhoto', !form.requiresPhoto)}
          >
            <span className="chore-approval-check" aria-hidden>{form.requiresPhoto ? '✓' : ''}</span>
            <span>
              <span className="chore-approval-t">Requires a photo</span>
              <span className="chore-approval-s">A snapshot of the finished job is needed to complete it.</span>
            </span>
          </button>

          <div style={{ display: 'flex', gap: 9, marginTop: 6, alignItems: 'center' }}>
            {editing && (
              <button
                type="button"
                onClick={del}
                disabled={saving}
                style={{ border: 0, background: 'none', font: 'inherit', fontWeight: 700, fontSize: 14, color: 'var(--primary)', cursor: 'pointer', padding: '10px 4px' }}
              >
                {confirmDelete ? 'Tap again to delete' : 'Delete'}
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!form.title.trim() || saving || (form.freq === 'weekly' && form.days.length === 0)}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {saving ? 'Saving…' : editing ? 'Save' : 'Add chore'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
