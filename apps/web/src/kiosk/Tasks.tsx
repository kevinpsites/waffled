import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Icon, Check } from './icons'
import { ChoreModal, type ChoreDraft } from './components/ChoreModal'
import { RewardsPanel } from './components/RewardsPanel'
import { choresApi, usePersons, useDayInstances, useCurrencies, localToday, type ChoreInstance } from '../lib/api'

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
  return { id: i.choreId, title: i.choreTitle, emoji: i.emoji, personId: i.personId, rewardAmount: i.rewardAmount, rewardCurrency: i.rewardCurrency, rrule: i.rrule }
}

// The Tasks screen: today's chores per person. Tick to complete/uncomplete;
// click a chore to edit; add chores per person or via New.
export function Tasks() {
  const [date, setDate] = useState(() => localToday())
  const { instances, loading, error, setDone, assign, refetch } = useDayInstances(date)
  const { persons } = usePersons()
  const { byKey: currencyByKey, defaultCurrency } = useCurrencies()
  const groups = buildColumns(instances, persons)
  const [modal, setModal] = useState<{ chore?: ChoreDraft; personId?: string | null } | null>(null)
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<'chores' | 'rewards'>(searchParams.get('tab') === 'rewards' ? 'rewards' : 'chores')
  const [claimId, setClaimId] = useState<string | null>(null)
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
        <div className="seg" style={{ marginLeft: 'auto' }}>
          <button className={tab === 'chores' ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab('chores')}>Chores</button>
          <button className={tab === 'rewards' ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab('rewards')}>Rewards</button>
        </div>
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

      {tab === 'rewards' && <RewardsPanel />}

      {tab === 'chores' && (
      <div className="tasks-screen">
        {loading && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
        {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see chores.</div>}
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
                      onClick={() => (upForGrabs ? setClaimId(picking ? null : i.id) : setDone(i.id, !isComplete))}
                    >
                      {isAwaiting ? '⏳' : ''}
                    </button>
                    <div className="body" style={{ cursor: 'pointer' }} onClick={() => setModal({ chore: draftFrom(i) })}>
                      <div
                        className="t"
                        style={{ textDecoration: isDone ? 'line-through' : 'none', color: isDone ? 'var(--ink-3)' : undefined }}
                      >
                        {i.emoji ? `${i.emoji} ` : ''}
                        {i.choreTitle}
                        {i.streak >= 2 && <span className="chore-streak" title={`${i.streak}-day streak`}>🔥 {i.streak}</span>}
                      </div>
                      <div className="star">
                        <span style={{ fontSize: 12 }}>{(i.rewardCurrency ? currencyByKey[i.rewardCurrency] : defaultCurrency)?.symbol ?? '⭐'}</span> {i.rewardAmount ?? 0}
                        {isAwaiting && <span className="chore-awaiting-tag">Needs OK</span>}
                      </div>
                    </div>
                    {isAwaiting && (
                      <div className="chore-approve" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="ca-reject" onClick={() => reject(i.id)}>Reject</button>
                        <button type="button" className="ca-approve" onClick={() => approve(i.id)}>Approve</button>
                      </div>
                    )}
                    {upForGrabs && picking && (
                      <div className="claim-pick" onClick={(e) => e.stopPropagation()}>
                        <span className="claim-pick-q">Who did it?</span>
                        {persons.map((p) => (
                          <button key={p.id} type="button" className="claim-p" title={`${p.name} did it`} onClick={() => claimAndComplete(i.id, p.id)}>
                            {p.avatarEmoji ?? '🙂'}
                          </button>
                        ))}
                        <button type="button" className="claim-x" onClick={() => setClaimId(null)}>×</button>
                      </div>
                    )}
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

      {modal && (
        <ChoreModal chore={modal.chore} personId={modal.personId} onClose={() => setModal(null)} onSaved={refetch} />
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
