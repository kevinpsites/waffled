import { useState, type FormEvent } from 'react'
import { api, usePersons, useCurrencies, localToday } from '../../lib/api'

export interface ChoreDraft {
  id: string
  instanceId?: string
  title: string
  emoji: string | null
  personId: string | null
  rewardAmount: number | null
  rewardCurrency?: string | null
  rrule?: string | null
  dueTime?: string | null
  dueOn?: string | null
  requiresApproval?: boolean
  requiresPhoto?: boolean
  status?: string
}

const DAYS: Array<[string, string]> = [
  ['MO', 'Mon'], ['TU', 'Tue'], ['WE', 'Wed'], ['TH', 'Thu'], ['FR', 'Fri'], ['SA', 'Sat'], ['SU', 'Sun'],
]

type Freq = 'once' | 'daily' | 'weekly'
type ChoreScope = 'this' | 'following' | 'all'
type ScopeAction =
  | { kind: 'save'; payload: Record<string, unknown>; repeatChanged: boolean }
  | { kind: 'delete'; repeatChanged: false }

function parseRrule(
  rrule: string | null | undefined,
  editing: boolean,
  defaultFreq: Freq = 'daily'
): { freq: Freq; days: string[] } {
  if (rrule && /FREQ=WEEKLY/i.test(rrule)) {
    const m = rrule.match(/BYDAY=([A-Z,]+)/i)
    return { freq: 'weekly', days: m ? m[1].toUpperCase().split(',') : [] }
  }
  if (rrule && /FREQ=DAILY/i.test(rrule)) return { freq: 'daily', days: [] }
  // No rrule: an existing chore with null rrule is a one-off; a brand-new chore defaults to
  // "Every day" unless the surface opening the modal knows better (Weekly Planning asks
  // for 'once').
  return { freq: editing ? 'once' : defaultFreq, days: [] }
}

function buildRrule(freq: Freq, days: string[]): string | null {
  if (freq === 'once') return null // one-off — no recurrence
  if (freq === 'weekly' && days.length) {
    const sorted = DAYS.map((d) => d[0]).filter((d) => days.includes(d))
    return `FREQ=WEEKLY;BYDAY=${sorted.join(',')}`
  }
  return 'FREQ=DAILY'
}

function initialForm(
  chore?: ChoreDraft,
  personId?: string | null,
  canAssignOthers = true,
  selfPersonId?: string | null,
  defaultFreq?: Freq,
  defaultDueOn?: string,
  defaultTitle?: string
) {
  const sched = parseRrule(chore?.rrule, !!chore, defaultFreq)
  // Restricted users (no chore.manage) can only target themselves or up-for-grabs; default
  // them to self rather than the full-list default.
  const prefill = chore?.personId ?? personId ?? (canAssignOthers ? '' : selfPersonId ?? '')
  return {
    title: chore?.title ?? defaultTitle ?? '',
    emoji: chore?.emoji ?? '',
    personId: prefill,
    rewardAmount: chore?.rewardAmount ?? 1,
    rewardCurrency: chore?.rewardCurrency ?? '',
    freq: sched.freq,
    days: sched.days,
    // One-off only: which day the single task lands on.
    dueOn: chore?.dueOn || defaultDueOn || localToday(),
    // Optional time-of-day (HH:MM), for one-offs and each recurring occurrence.
    dueTime: (chore?.dueTime ?? '').slice(0, 5),
    requiresApproval: chore?.requiresApproval ?? false,
    requiresPhoto: chore?.requiresPhoto ?? false,
  }
}

// Create (optional `personId` prefill) or edit (`chore`) a chore definition.
export function ChoreModal({
  chore,
  personId,
  defaultFreq,
  defaultDueOn,
  defaultTitle,
  canDelete = true,
  canAssignOthers = true,
  selfPersonId,
  onClose,
  onSaved,
}: {
  chore?: ChoreDraft
  personId?: string | null
  // Which "Repeats" a NEW chore starts on. Omit for the app-wide default ('daily'). Ignored
  // when editing — an existing chore's cadence is its own.
  defaultFreq?: Freq
  // Which day a NEW one-off starts on. Omit for today; a surface planning a different week
  // passes that week's day. Still editable here, and ignored when editing.
  defaultDueOn?: string
  // What a NEW chore's title starts as — Weekly Planning passes a parked note's words, so
  // nobody retypes what they already wrote down.
  defaultTitle?: string
  // Whether editing may also DELETE the chore. True for the Chores screen; a surface with a
  // narrower question (Weekly Planning's Tasks step) passes false and gets an editor without a
  // removal it isn't offering.
  canDelete?: boolean
  // Without chore.manage, restrict the assignee picker to self + up-for-grabs.
  canAssignOthers?: boolean
  selfPersonId?: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = !!chore
  const { persons } = usePersons()
  const { currencies, defaultCurrency } = useCurrencies()
  const [form, setForm] = useState(() =>
    initialForm(chore, personId, canAssignOthers, selfPersonId, defaultFreq, defaultDueOn, defaultTitle))
  const pickable = canAssignOthers ? persons : persons.filter((p) => p.id === selfPersonId)
  // A parent doesn't need another parent's OK: hide the approval toggle when the chore is
  // assigned to an adult/admin. Still shown for kids, teens and "up for grabs".
  const assignee = persons.find((p) => p.id === form.personId)
  const assigneeIsAdult = !!assignee && (assignee.memberType === 'adult' || assignee.isAdmin)
  const curKey = form.rewardCurrency || defaultCurrency?.key || 'stars'
  const selectedCur = currencies.find((c) => c.key === curKey)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [scopeAction, setScopeAction] = useState<ScopeAction | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const selectedOccurrenceIsPending = chore?.status === 'pending'
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || saving) return
    setSaveError(null)
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
      if (editing && chore?.rrule && chore.instanceId) {
        setSaving(false)
        setScopeAction({ kind: 'save', payload, repeatChanged: buildRrule(form.freq, form.days) !== chore.rrule })
        return
      }
      // A ONE-OFF CARRIES ITS DAY EITHER WAY: on create it is where the single instance lands,
      // on EDIT it moves that instance. A recurring chore sends none — its days come from the
      // rrule, and the server ignores dueOn for one.
      const withDay = form.freq === 'once' ? { ...payload, dueOn: form.dueOn } : payload
      if (editing) await api.updateChore(chore!.id, withDay)
      else await api.createChore(withDay)
      onSaved()
      onClose()
    } catch {
      setSaveError('Couldn\'t save this chore. Check your connection and try again.')
      setSaving(false)
    }
  }

  async function del() {
    if (!editing || saving) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    if (chore?.rrule && chore.instanceId) {
      setConfirmDelete(false)
      setScopeAction({ kind: 'delete', repeatChanged: false })
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await api.deleteChore(chore!.id)
      onSaved()
      onClose()
    } catch {
      setSaveError('Couldn\'t delete this chore. Check your connection and try again.')
      setSaving(false)
    }
  }

  async function applyScope(scope: ChoreScope) {
    if (!scopeAction || !chore?.instanceId) return
    setSaveError(null)
    setSaving(true)
    try {
      const target = { scope, instanceId: chore.instanceId }
      if (scopeAction.kind === 'save') await api.updateChore(chore.id, scopeAction.payload, target)
      else await api.deleteChore(chore.id, target)
      onSaved()
      onClose()
    } catch {
      setSaveError(
        scopeAction.kind === 'save'
          ? 'Couldn\'t save this chore. Check your connection and try again.'
          : 'Couldn\'t delete this chore. Check your connection and try again.'
      )
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

        {saveError && (
          <div role="alert" className="tiny" style={{ color: 'var(--primary)', fontWeight: 700, marginBottom: 12 }}>
            {saveError}
          </div>
        )}

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
            {/* One-off: pick the day — ON EDIT TOO, because an existing one-off is otherwise
                unmovable and the Tasks step's day chip opens this editor for exactly that.
                `min` stays create-only, though: a carried-over chore is dated in the PAST, and
                Save lives inside a <form>, so flooring the input at today would let the browser
                refuse the submit and make Save look dead on those very cards. */}
            {form.freq === 'once' && (
              <label className="field" style={{ marginTop: 8 }}>
                <span>On</span>
                <input type="date" {...(editing ? {} : { min: localToday() })} value={form.dueOn} onChange={(e) => set('dueOn', e.target.value || localToday())} />
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

          {scopeAction && (
            <div role="dialog" aria-label="Choose recurring chore scope" className="wf-field" style={{ marginTop: 12, padding: 13 }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                {scopeAction.kind === 'save' ? 'Which chores should change?' : 'Which chores should be deleted?'}
              </div>
              <div className="tiny muted" style={{ marginBottom: 10 }}>
                {selectedOccurrenceIsPending
                  ? 'Completed chores and items awaiting approval always stay unchanged.'
                  : 'The selected completed or awaiting-approval chore stays unchanged. Only future pending chores are affected.'}
              </div>
              <div style={{ display: 'grid', gap: 7 }}>
                {!scopeAction.repeatChanged && selectedOccurrenceIsPending && (
                  <button type="button" className="btn" disabled={saving} onClick={() => applyScope('this')}>
                    This chore only
                  </button>
                )}
                <button type="button" className="btn" disabled={saving} onClick={() => applyScope('following')}>
                  This and future chores
                </button>
                <button type="button" className="btn" disabled={saving} onClick={() => applyScope('all')}>
                  Entire active series
                </button>
                <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => { setScopeAction(null); setSaveError(null) }}>
                  Cancel
                </button>
              </div>
              {scopeAction.repeatChanged && (
                <div className="tiny muted" style={{ marginTop: 8 }}>
                  Repeat changes must apply from this chore forward or to the entire series.
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9, marginTop: 6, alignItems: 'center' }}>
            {editing && canDelete && (
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
