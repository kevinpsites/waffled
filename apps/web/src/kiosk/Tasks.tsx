import { Star } from './icons'
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

// The Tasks screen: today's chores per person, with a tick to complete/uncomplete.
// Completing one awards stars and moves the rings on the Today dashboard.
export function Tasks() {
  const { instances, loading, error, setDone } = useTodayInstances()
  const groups = groupByPerson(instances)

  return (
    <div className="tasks-screen">
      {loading && <div className="muted" style={{ padding: 20 }}>Loading…</div>}
      {error && <div className="muted" style={{ padding: 20 }}>Sign this kiosk in to see chores.</div>}
      {!loading && !error && instances.length === 0 && (
        <div className="muted" style={{ padding: 20 }}>No chores today.</div>
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
                  <div className="body">
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
          </div>
        )
      })}
    </div>
  )
}
