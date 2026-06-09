import { useEffect, useRef, useState } from 'react'

// A pill that opens a checkbox popover for selecting multiple values.
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (options.length === 0) return null
  const toggle = (o: string) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o])
  const text = selected.length === 0 ? label : `${label} · ${selected.length}`

  return (
    <div className="ms-wrap" ref={ref}>
      <button type="button" className={`recipes-filter ${selected.length ? 'on' : ''}`} onClick={() => setOpen((v) => !v)}>
        {text}
      </button>
      {open && (
        <div className="ms-menu">
          {options.map((o) => {
            const on = selected.includes(o)
            return (
              <button key={o} type="button" className="ms-opt" onClick={() => toggle(o)}>
                <span className={`ms-ck ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span>
                <span className="ms-opt-t">{o}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
