import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Icon, Check } from './icons'
import { ChoreModal, type ChoreDraft } from './components/ChoreModal'
import { RewardsPanel } from './components/RewardsPanel'
import { ChoreApprovalsCard, ChoreProofModal } from './components/Approvals'
import { choresApi, usePersons, useHousehold, can, useDayInstances, useAwaitingChores, useCurrencies, localToday, uploadImage, type ChoreInstance } from '../lib/api'
import { moduleEnabled } from '../lib/modules'

// Shift a YYYY-MM-DD by N days (local), and describe a day relative to today.
function shiftDate(d: string, days: number): string {
  const dt = new Date(`${d}T00:00:00`)
  dt.setDate(dt.getDate() + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
function dayMeta(d: string): { rel: string; full: string; diff: number; weekday: string } {
  const dt = new Date(`${d}T00:00:00`)
  const diff = Math.round((dt.getTime() - new Date(`${localToday()}T00:00:00`).getTime()) / 86_400_000)
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : diff > 0 ? `In ${diff} days` : `${-diff} days ago`
  const full = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long' })
  return { rel, full, diff, weekday }
}

// A carried-forward one-off keeps its original due date, so when it shows up on a
// later day it's overdue. Describe how long ago it was due ("since Mon", or a date
// once it's more than a week old). Returns null when it's not actually overdue.
function overdueLabel(dueOn: string, viewing: string): string | null {
  const due = new Date(`${dueOn}T00:00:00`)
  const ref = new Date(`${viewing}T00:00:00`)
  const diff = Math.round((ref.getTime() - due.getTime()) / 86_400_000)
  if (diff <= 0) return null
  if (diff === 1) return 'since yesterday'
  if (diff < 7) return `since ${due.toLocaleDateString('en-US', { weekday: 'short' })}`
  return `since ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

type Column = { key: string; name: string; items: ChoreInstance[]; emoji?: string | null; color?: string | null }
type PersonLite = { id: string; name: string; avatarEmoji?: string | null; colorHex?: string | null }

// Columns are driven by the (stably ordered) people list, NOT by whichever
// instances happen to exist — so the order never jumps, Up-for-grabs is always
// present (as the leftmost column), and every person shows even with an empty
// list (so you can add to them). Each person carries their color + icon.
function buildColumns(instances: ChoreInstance[], persons: PersonLite[]): Column[] {
  const byPerson = new Map<string, ChoreInstance[]>()
  const unassigned: ChoreInstance[] = []
  for (const i of instances) {
    if (i.personId == null) {
      unassigned.push(i)
      continue
    }
    const arr = byPerson.get(i.personId) ?? []
    arr.push(i)
    byPerson.set(i.personId, arr)
  }
  const cols: Column[] = [{ key: 'unassigned', name: 'Up for grabs', items: unassigned }]
  const seen = new Set<string>()
  for (const p of persons) {
    cols.push({ key: p.id, name: p.name, emoji: p.avatarEmoji, color: p.colorHex, items: byPerson.get(p.id) ?? [] })
    seen.add(p.id)
  }
  // Instances assigned to someone no longer in the list (e.g. just removed) still appear.
  for (const [pid, items] of byPerson) {
    if (!seen.has(pid)) cols.push({ key: pid, name: items[0]?.personName ?? 'Someone', items })
  }
  return cols
}

function draftFrom(i: ChoreInstance): ChoreDraft {
  return { id: i.choreId, title: i.choreTitle, emoji: i.emoji, personId: i.personId, rewardAmount: i.rewardAmount, rewardCurrency: i.rewardCurrency, rrule: i.rrule, requiresApproval: i.requiresApproval, requiresPhoto: i.requiresPhoto }
}

// The Tasks screen: today's chores per person. Tick to complete/uncomplete;
// click a chore to edit; add chores per person or via New.
export function Tasks() {
  const [date, setDate] = useState(() => localToday())
  const { instances, loading, error, setDone, assign, refetch } = useDayInstances(date)
  const { persons } = usePersons()
  const { person, household } = useHousehold()
  // Rewards live as a tab on this (chores) page; hide it when the rewards module is off.
  const rewardsOn = moduleEnabled(household, 'rewards')
  // Anyone can add a chore for themselves / up-for-grabs; assigning it to someone
  // else needs chore.manage (carved-out server-side, gated here to avoid the 403).
  const canAssignOthers = can(person, 'chore.manage')
  const canApprove = can(person, 'chore.approve')
  const cur = useCurrencies()
  const awaiting = useAwaitingChores()
  const groups = buildColumns(instances, persons)
  const [modal, setModal] = useState<{ chore?: ChoreDraft; personId?: string | null } | null>(null)
  const [searchParams] = useSearchParams()
  const [tabState, setTab] = useState<'chores' | 'rewards'>(searchParams.get('tab') === 'rewards' ? 'rewards' : 'chores')
  // Pin to chores whenever rewards is off, so a stale ?tab=rewards can't strand us.
  const tab = rewardsOn ? tabState : 'chores'
  const [claimId, setClaimId] = useState<string | null>(null)
  // Photo-proof capture: a hidden file input, the instance (and optional person to
  // claim first) we're capturing for, and any upload/guard error to surface.
  const fileRef = useRef<HTMLInputElement>(null)
  const [proofFor, setProofFor] = useState<{ instanceId: string; personId?: string } | null>(null)
  const [proofErr, setProofErr] = useState<string | null>(null)
  // The awaiting chore whose photo proof is open in the review modal.
  const [review, setReview] = useState<ChoreInstance | null>(null)
  const meta = dayMeta(date)
  const isToday = meta.diff === 0

  // Drag-and-drop to reassign a chore between columns. Pointer events (not HTML5
  // draggable) so it works with both a mouse and the kiosk's touchscreen. `drag`
  // is set once per drag so the move/up listener effect subscribes only once;
  // `pos` drives the floating ghost, `overCol` the drop highlight (read live via
  // a ref inside the up handler).
  const [drag, setDrag] = useState<{ id: string; from: string | null; title: string; emoji: string | null } | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [overCol, setOverCol] = useState<string | null>(null)
  const overColRef = useRef<string | null>(null)
  overColRef.current = overCol

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setPos({ x: e.clientX, y: e.clientY })
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const col = el && (el as Element).closest('[data-colkey]')
      setOverCol(col ? col.getAttribute('data-colkey') : null)
    }
    const up = () => {
      const target = overColRef.current
      // 'unassigned' column → personId null; a real column → that person id.
      if (target && target !== (drag.from ?? 'unassigned')) {
        assign(drag.id, target === 'unassigned' ? null : target)
      }
      setDrag(null)
      setOverCol(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
  }, [drag, assign])

  function startDrag(e: React.PointerEvent, i: ChoreInstance) {
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
    setOverCol(null)
    setDrag({ id: i.id, from: i.personId, title: i.choreTitle, emoji: i.emoji })
  }

  // Up-for-grabs: tapping "done" must credit someone, so we ask who did it, then
  // claim + complete in one motion (stars go to the picked person).
  async function claimAndComplete(instanceId: string, personId: string) {
    setClaimId(null)
    await choresApi.claimInstance(instanceId, personId).catch(() => {})
    await choresApi.completeInstance(instanceId).catch(() => {})
    refetch()
  }

  // Complete an assigned chore: photo-proof chores open the camera/file picker
  // first (then complete with the uploaded blob); the rest complete straight away.
  function completeAssigned(i: ChoreInstance) {
    if (i.requiresPhoto) startProof(i.id)
    else setDone(i.id, true)
  }
  // Open the photo picker for an instance, optionally claiming `personId` once a
  // photo is chosen (the up-for-grabs path).
  function startProof(instanceId: string, personId?: string) {
    setClaimId(null)
    setProofErr(null)
    setProofFor({ instanceId, personId })
    fileRef.current?.click()
  }
  // A photo was picked: downscale + upload, claim if needed, then complete with the
  // proof. Clears the picker's value so re-picking the same file fires onChange again.
  async function onProofPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = proofFor
    setProofFor(null)
    if (!file || !target) return
    try {
      const up = await uploadImage(file)
      if (target.personId) await choresApi.claimInstance(target.instanceId, target.personId)
      await choresApi.completeInstance(target.instanceId, { storageKey: up.key, contentType: up.contentType })
      refetch()
    } catch (err) {
      setProofErr(err instanceof Error ? err.message : 'Could not upload that photo — please try again.')
    }
  }
  async function approve(instanceId: string) {
    await choresApi.approveInstance(instanceId).catch(() => {})
    refetch()
  }
  async function reject(instanceId: string) {
    await choresApi.rejectInstance(instanceId).catch(() => {})
    refetch()
  }

  return (
    <div className="tasks-page">
      <div className="tasks-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>
          {tab === 'chores' ? `${Math.abs(meta.diff) <= 1 ? meta.rel : meta.weekday}’s chores` : 'Stars & rewards'}
        </div>
        {rewardsOn && (
          <div className="seg" style={{ marginLeft: 'auto' }}>
            <button className={tab === 'chores' ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab('chores')}>Chores</button>
            <button className={tab === 'rewards' ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab('rewards')}>Rewards</button>
          </div>
        )}
        {tab === 'chores' && (
          <button type="button" className="pill" style={{ cursor: 'pointer' }} onClick={() => setModal({})}>
            <Icon name="plus" />
            <span>New chore</span>
          </button>
        )}
      </div>

      {tab === 'chores' && (
        <div className="tasks-datenav">
          <button type="button" className="dn-arrow" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <div className="dn-label">
            <span className="dn-full">{meta.full}</span>
            <span className="dn-rel">{meta.rel}</span>
          </div>
          <button type="button" className="dn-arrow" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))}>›</button>
          {!isToday && (
            <button type="button" className="dn-today" onClick={() => setDate(localToday())}>Today</button>
          )}
        </div>
      )}

      {tab === 'chores' && proofErr && (
        <div style={{ padding: '0 30px 12px' }}>
          <div className="card" role="alert" style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', borderColor: 'var(--danger, #d9534f)' }}>
            <span style={{ flex: 1, fontSize: 14 }}>{proofErr}</span>
            <button type="button" className="pill" onClick={() => setProofErr(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {tab === 'chores' && canApprove && awaiting.chores.length > 0 && (
        <div style={{ padding: '0 30px 12px' }}>
          <ChoreApprovalsCard chores={awaiting.chores} cur={cur} busy={null} onApprove={approve} onReject={reject} />
        </div>
      )}

      {tab === 'rewards' && <RewardsPanel />}

      {tab === 'chores' && (
      <div className="tasks-screen">
        {loading && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
        {error && <div className="muted" style={{ padding: 20 }}>Couldn't load chores — try reloading or signing in again.</div>}
        {!loading && !error && groups.map((g) => {
          const done = g.items.filter((i) => i.status === 'done').length
          const upForGrabs = g.key === 'unassigned'
          const isDropTarget = !!drag && overCol === g.key && g.key !== (drag.from ?? 'unassigned')
          return (
            <div className={`chore-col ${upForGrabs ? 'up-for-grabs' : ''} ${isDropTarget ? 'drop-target' : ''}`} key={g.key} data-colkey={g.key}>
              <div className="chore-head">
                <span className="nm">
                  {upForGrabs ? (
                    <>
                      <span className="chore-ava grabs">🙌</span>
                      Up for grabs
                    </>
                  ) : (
                    <>
                      <span className="chore-ava" style={{ background: `${g.color ?? '#A6A29B'}22` }}>{g.emoji ?? '🙂'}</span>
                      {g.name}
                    </>
                  )}
                </span>
                <span className="badge" title="Chores done">
                  <Check size={13} /> {done}/{g.items.length}
                </span>
              </div>
              {upForGrabs && g.items.length > 0 && (
                <div className="tiny muted chore-grabs-hint">Tap a chore to claim it — whoever does it gets the stars.</div>
              )}
              {g.items.length === 0 && (
                <div className="tiny muted chore-empty">
                  {upForGrabs ? 'Nothing up for grabs — add one anyone can claim.' : `Nothing for ${g.name} ${isToday ? 'today' : 'this day'}.`}
                </div>
              )}
              <div className="chore-list">
              {g.items.map((i) => {
                const isDone = i.status === 'done'
                const isAwaiting = i.status === 'awaiting'
                const isComplete = isDone || isAwaiting
                const picking = claimId === i.id
                return (
                  <div className="chore" key={i.id}>
                    <button
                      type="button"
                      className={`tick ${isDone ? 'done' : ''} ${isAwaiting ? 'awaiting' : ''}`}
                      aria-label={upForGrabs ? `Claim and complete ${i.choreTitle}` : `${isComplete ? 'Uncomplete' : 'Complete'} ${i.choreTitle}`}
                      onClick={() => {
                        if (upForGrabs) setClaimId(picking ? null : i.id)
                        else if (isComplete) setDone(i.id, false)
                        else completeAssigned(i)
                      }}
                    >
                      {isAwaiting ? '⏳' : i.requiresPhoto && !isComplete ? '📷' : ''}
                    </button>
                    {/* Editing a chore needs chore.manage — non-managers can still
                        complete (tick) and claim (below), just not open the editor. */}
                    <div className="body" style={{ cursor: canAssignOthers ? 'pointer' : 'default' }} onClick={canAssignOthers ? () => setModal({ chore: draftFrom(i) }) : undefined}>
                      <div
                        className="t"
                        style={{ textDecoration: isDone ? 'line-through' : 'none', color: isDone ? 'var(--ink-3)' : undefined }}
                      >
                        {i.emoji ? `${i.emoji} ` : ''}
                        {i.choreTitle}
                        {i.streak >= 2 && <span className="chore-streak" title={`${i.streak}-day streak`}>🔥 {i.streak}</span>}
                        {!isComplete && (() => {
                          const od = overdueLabel(i.dueOn, date)
                          return od ? <span className="chore-overdue" title={`Was due ${i.dueOn}`}>overdue · {od}</span> : null
                        })()}
                      </div>
                      <div className="star">
                        <span style={{ fontSize: 12 }}>{(i.rewardCurrency ? cur.byKey[i.rewardCurrency] : cur.defaultCurrency)?.symbol ?? '⭐'}</span> {i.rewardAmount ?? 0}
                        {isAwaiting && <span className="chore-awaiting-tag">Needs OK</span>}
                      </div>
                    </div>
                    {isAwaiting && canApprove && (
                      <div className="chore-approve" onClick={(e) => e.stopPropagation()}>
                        {i.proofUrl ? (
                          // Photo chores review in the modal (where Approve/Reject live)
                          // — keeps the narrow column from getting cramped.
                          <button type="button" className="chore-review" title="Review photo proof" aria-label={`Review photo proof for ${i.choreTitle}`} onClick={() => setReview(i)}>
                            <img src={i.proofUrl} alt={`Proof for ${i.choreTitle}`} />
                            <span className="chore-review-badge" aria-hidden>🔍</span>
                          </button>
                        ) : (
                          <>
                            <button type="button" className="ca-reject" onClick={() => reject(i.id)}>Reject</button>
                            <button type="button" className="ca-approve" onClick={() => approve(i.id)}>Approve</button>
                          </>
                        )}
                      </div>
                    )}
                    {upForGrabs && picking && (
                      <div className="claim-pick" onClick={(e) => e.stopPropagation()}>
                        <span className="claim-pick-q">Who did it?</span>
                        {persons.map((p) => (
                          <button key={p.id} type="button" className="claim-p" title={`${p.name} did it`} onClick={() => (i.requiresPhoto ? startProof(i.id, p.id) : claimAndComplete(i.id, p.id))}>
                            {p.avatarEmoji ?? '🙂'}
                          </button>
                        ))}
                        <button type="button" className="claim-x" onClick={() => setClaimId(null)}>×</button>
                      </div>
                    )}
                    {/* Drag-to-reassign assigns the chore to someone else, which
                        needs chore.manage — hide the grip otherwise. */}
                    {canAssignOthers && (
                      <button
                        type="button"
                        className="chore-grip"
                        aria-label={`Move ${i.choreTitle} to another person`}
                        title="Drag to assign"
                        onPointerDown={(e) => startDrag(e, i)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        ⠿
                      </button>
                    )}
                  </div>
                )
              })}
              </div>
              <button type="button" className="chore-add" onClick={() => setModal({ personId: g.key === 'unassigned' ? null : g.key })}>
                <Icon name="plus" />
                Add chore
              </button>
            </div>
          )
        })}
      </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onProofPicked}
      />

      {review && (() => {
        // Stay bound to the live instance so an approve/reject elsewhere closes the
        // modal once the chore leaves the awaiting queue.
        const live = instances.find((x) => x.id === review.id && x.status === 'awaiting')
        if (!live) return null
        return (
          <ChoreProofModal
            instance={live}
            cur={cur}
            busy={null}
            onApprove={approve}
            onReject={reject}
            onClose={() => setReview(null)}
          />
        )
      })()}

      {modal && (
        <ChoreModal chore={modal.chore} personId={modal.personId} canAssignOthers={canAssignOthers} selfPersonId={person?.id ?? null} onClose={() => setModal(null)} onSaved={refetch} />
      )}

      {drag && (
        <div className="chore-drag-ghost" style={{ left: pos.x, top: pos.y }}>
          {drag.emoji ? `${drag.emoji} ` : ''}
          {drag.title}
        </div>
      )}
    </div>
  )
}
