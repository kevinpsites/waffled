import { useState } from 'react'

// Small comma/enter chip editor for an array field (dietary, vegetables, tags…).
// Lifted out of the old CustomizeModal so the unified recipe editor can reuse it.
export function ChipEditor({
  items,
  onChange,
  placeholder,
  color = '#e9eef6',
}: {
  items: string[]
  onChange: (next: string[]) => void
  placeholder: string
  color?: string
}) {
  const [draft, setDraft] = useState('')
  function commit() {
    const v = draft.trim()
    if (v && !items.some((i) => i.toLowerCase() === v.toLowerCase())) onChange([...items, v])
    setDraft('')
  }
  return (
    <div className="cz-chips">
      {items.map((it) => (
        <span key={it} className="cz-chip" style={{ background: color }}>
          {it}
          <button type="button" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))}>×</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
        }}
        placeholder={placeholder}
      />
    </div>
  )
}
