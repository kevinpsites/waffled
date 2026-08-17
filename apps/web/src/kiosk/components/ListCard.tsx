import { useEffect, useMemo, useState } from 'react'
import { useLists, useListDetail, groceryApi, type ListItem } from '../../lib/api'

// The Today "Lists" card — pins ONE of the household's custom lists so the school
// run / hardware run / packing list sits on the board next to everything else.
//
// Which list is pinned is a per-DEVICE choice (localStorage), not household config:
// the kitchen kiosk and a phone want different lists up, and the Goals card already
// makes exactly this call with its pinned goal. That is also what keeps this card out
// of the layout enum — the layout stores the single key `lists`, and the *content*
// is chosen here, so no `list:<uuid>` key ever has to be validated or reaped.
export const TODAY_LIST_PICK_KEY = 'waffled.todayListPick'

export function ListCard() {
  const { lists, loading: listsLoading, error: listsError } = useLists()
  const [pick, setPick] = useState<string | null>(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem(TODAY_LIST_PICK_KEY) : null)
  )

  // The grocery board has its own Today card; offering it here too would be two
  // cards fighting over one list. Templates aren't real lists you shop from.
  const pickable = useMemo(
    () => lists.filter((l) => l.listType !== 'grocery' && l.listType !== 'template' && !l.isAutoBuilt),
    [lists]
  )

  // A pinned list that has since been deleted must not leave the card blank and
  // stuck, so an unknown pick falls back to whatever the household still has.
  const active = pickable.find((l) => l.id === pick) ?? pickable[0] ?? null
  const { items, loading, error } = useListDetail(active?.id ?? null)

  // Keep the remembered pick honest when the list it named has gone away.
  useEffect(() => {
    if (active && pick && active.id !== pick) choose(active.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  function choose(id: string) {
    setPick(id)
    try {
      localStorage.setItem(TODAY_LIST_PICK_KEY, id)
    } catch {
      // private mode / storage disabled — the choice just won't persist
    }
  }

  // Optimistic: the row disappears the moment it's ticked. The card only ever shows
  // unfinished items, so there is nothing to strike through and wait on.
  const [done, setDone] = useState<Set<string>>(new Set())
  useEffect(() => setDone(new Set()), [active?.id])

  async function check(item: ListItem) {
    setDone((prev) => new Set(prev).add(item.id))
    try {
      await groceryApi.setItemChecked(item.id, true)
    } catch {
      setDone((prev) => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  const open = items.filter((i) => !i.checked && !done.has(i.id))

  return (
    <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
      {/* The card lives in a narrow column, so the title truncates and the picker
          carries no visible label — its accessible name does the work. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div
          className="card-h"
          style={{ fontSize: 17, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={active?.name}
        >
          {active ? `${active.emoji ? `${active.emoji} ` : ''}${active.name}` : 'Lists'}
        </div>
        {pickable.length > 1 && (
          <select
            className="sel"
            aria-label="Which list"
            style={{ marginLeft: 'auto', maxWidth: 130 }}
            value={active?.id ?? ''}
            onChange={(e) => choose(e.target.value)}
          >
            {pickable.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* "No lists yet" is a claim about the household, so only make it once the
          fetch has actually come back empty — a dropped connection reads as an empty
          house, and so does an in-flight request on a slow link. Matches the
          GroceryCard sitting next to it. */}
      {pickable.length === 0 && (
        <div className="tiny muted" style={{ paddingBottom: 6 }}>
          {listsError
            ? "Couldn't load your lists — reload or sign in again."
            : listsLoading
              ? 'Loading…'
              : "No lists yet — make one in Lists and it'll show up here."}
        </div>
      )}
      {active && loading && <div className="tiny muted">Loading…</div>}
      {active && error && <div className="tiny muted">Couldn't load the list — reload or sign in again.</div>}
      {active && !loading && !error && open.length === 0 && (
        <div className="tiny muted" style={{ paddingBottom: 6 }}>All done here. 🎉</div>
      )}

      <div className="gc-scroll">
        {open.map((item) => (
          <div key={item.id} className="gitem" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7 }}>
            <button
              type="button"
              onClick={() => check(item)}
              aria-label={`Check off ${item.name}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                background: 'none', border: 0, padding: 0, font: 'inherit',
                textAlign: 'left', cursor: 'pointer',
              }}
            >
              <span className="gcheck" />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
                {item.quantity ? <span className="tiny muted"> ({item.quantity})</span> : null}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
