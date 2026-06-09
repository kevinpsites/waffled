import { useState } from 'react'
import { Icon, Star } from './icons'
import { ChoreModal, type ChoreDraft } from './components/ChoreModal'
import { useTodayInstances, type ChoreInstance } from '../lib/api'

function groupByPerson(instances: ChoreInstance[]): Array<{ key: string; name: string; items: ChoreInstance[] }> {
  const map = new Map<string, { key: string; name: string; items: ChoreInstance[] }>()
  for (const i of instances) {
    const key = i.personId ?? 'unassigned'
    if (!map.has(key)) map.set(key, { key, name: i.personName ?? 'Up for grabs', items: [] })
    map.get(key)!.items.push(i)
  }
  return [...map.values()]
}

function draftFrom(i: ChoreInstance): ChoreDraft {
  return { id: i.choreId, title: i.choreTitle, emoji: i.emoji, personId: i.personId, rewardAmount: i.rewardAmount }
}

// The Tasks screen: today's chores per person. Tick to complete/uncomplete;
// click a chore to edit; add chores per person or via New.
export function Tasks() {
  const { instances, loading, error, setDone, refetch } = useTodayInstances()
  const groups = groupByPerson(instances)
  const [modal, setModal] = useState<{ chore?: ChoreDraft; personId?: string | null } | null>(null)

  return (
    <div className="tasks-page">
      <div className="tasks-head">
        <div className="card-h nk-serif" style={{ fontSize: 20 }}>
          Today’s chores
        </div>
        <button type="button" className="pill" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setModal({})}>
          <Icon name="plus" />
          <span>New chore</span>
        </button>
      </div>

      <div className="tasks-screen">
        {loading && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
        {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see chores.</div>}
        {!loading && !error && instances.length === 0 && (
          <div className="muted" style={{ padding: 20 }}>No chores yet — add one with “New chore”.</div>
        )}
        {groups.map((g) => {
          const done = g.items.filter((i) => i.status === 'done').length
          return (
            <div className="chore-col" key={g.key}>
              <div className="chore-head">
                <span className="nm">{g.name}</span>
                <span className="badge">
                  <Star size={13} /> {done}/{g.items.length}
                </span>
              </div>
              {g.items.map((i) => {
                const isDone = i.status === 'done'
                return (
                  <div className="chore" key={i.id}>
                    <button
                      type="button"
                      className={`tick ${isDone ? 'done' : ''}`}
                      aria-label={`${isDone ? 'Uncomplete' : 'Complete'} ${i.choreTitle}`}
                      onClick={() => setDone(i.id, !isDone)}
                    />
                    <div className="body" style={{ cursor: 'pointer' }} onClick={() => setModal({ chore: draftFrom(i) })}>
                      <div
                        className="t"
                        style={{ textDecoration: isDone ? 'line-through' : 'none', color: isDone ? 'var(--ink-3)' : undefined }}
                      >
                        {i.emoji ? `${i.emoji} ` : ''}
                        {i.choreTitle}
                      </div>
                      <div className="star">
                        <Star size={12} /> {i.rewardAmount ?? 0}
                      </div>
                    </div>
                  </div>
                )
              })}
              <button type="button" className="chore-add" onClick={() => setModal({ personId: g.key === 'unassigned' ? null : g.key })}>
                <Icon name="plus" />
                Add chore
              </button>
            </div>
          )
        })}
      </div>

      {modal && (
        <ChoreModal chore={modal.chore} personId={modal.personId} onClose={() => setModal(null)} onSaved={refetch} />
      )}
    </div>
  )
}
