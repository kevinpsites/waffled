import { useState } from 'react'
import { pantryApi } from '../../lib/api'

const NEW = '__new__'

// The "Where" picker used by both the add-by-hand and the scan sheets. It's the
// configured section list PLUS an inline "＋ New section…" escape hatch: you're
// standing at the freezer holding a bag, and the place it belongs doesn't exist
// yet — that shouldn't send you to Settings and lose what you were adding.
// Creating one appends it to the household's pantry config, so it also shows up
// in the sidebar straight away.
export function LocationField({ value, locations, onChange, onLocationsChanged }: {
  value: string
  locations: string[]
  onChange: (location: string) => void
  /** Called after a section is created so the parent can refetch its config. */
  onLocationsChanged?: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function cancel() {
    setAdding(false)
    setDraft('')
    setErr(null)
  }

  async function create() {
    const name = draft.trim()
    if (!name || busy) return
    setBusy(true)
    setErr(null)
    try {
      await pantryApi.addLocation(name)
      onChange(name)
      onLocationsChanged?.()
      setAdding(false)
      setDraft('')
    } catch {
      setErr('Could not add that section.')
    } finally {
      setBusy(false)
    }
  }

  if (adding) {
    return (
      <>
        <div className="pl-newloc-row">
          <input
            value={draft}
            autoFocus
            placeholder="New section name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); create() }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
          />
          <button type="button" className="pill" aria-label="Add section" disabled={busy || !draft.trim()} onClick={create}>
            {busy ? '…' : 'Add'}
          </button>
          <button type="button" className="pill" aria-label="Cancel new section" disabled={busy} onClick={cancel}>×</button>
        </div>
        {err && <span className="pl-lookup-msg">{err}</span>}
      </>
    )
  }

  return (
    <select
      aria-label="Location"
      value={value}
      onChange={(e) => (e.target.value === NEW ? setAdding(true) : onChange(e.target.value))}
    >
      {locations.map((l) => <option key={l} value={l}>{l}</option>)}
      {!locations.includes(value) && <option value={value}>{value}</option>}
      <option value={NEW}>＋ New section…</option>
    </select>
  )
}
