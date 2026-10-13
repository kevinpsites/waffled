import type { KeyboardEvent } from 'react'
import { Check } from '../icons'
import type { Typeface } from '../../lib/theme'

// Mirrors the TypefacePicker in the Waffled Claude Design system. Each option draws
// its specimen in its own typeface (.tp-opt[data-tp] in styles/typefaces.css), so
// people choose by reading, not by name. It only reports a choice; lib/theme applies it.
export const TYPEFACES: ReadonlyArray<{ id: Typeface; label: string; family: string; note: string }> = [
  { id: 'classic', label: 'Classic', family: 'System fonts', note: "The theme's own fonts: the device's system text with New York headings." },
  { id: 'clear', label: 'Clear', family: 'Lexend', note: 'Lexend. Wide letters and a tall x-height, built for reading fluency; the easiest to read from across the room.' },
  { id: 'hyperlegible', label: 'Hyperlegible', family: 'Atkinson Hyperlegible Next', note: 'Atkinson Hyperlegible Next. Every letter shaped to be told apart (I l 1, 0 O, rn m), for low vision and quick glances.' },
  { id: 'friendly', label: 'Friendly', family: 'Nunito', note: 'Nunito. Rounded, warm and open; heavy weights stay clear for headings and the clock.' },
  { id: 'early-reader', label: 'Early reader', family: 'Andika', note: 'Andika. Letters shaped the way kids learn to write them (single-storey a and g), for new readers in the house.' },
]

export function TypefacePicker({
  value = 'classic',
  onChange,
  options,
  compact,
  sample,
  label = 'Typeface',
}: {
  value?: Typeface
  onChange?: (id: Typeface) => void
  options?: Typeface[]
  compact?: boolean
  sample?: { clock?: string; title?: string; body?: string }
  label?: string
}) {
  const clock = sample?.clock ?? '6:30 PM'
  const title = sample?.title ?? 'Tacos tonight'
  const body = sample?.body ?? 'Il1 0O · Pick up milk'
  const list = options ? TYPEFACES.filter((t) => options.includes(t.id)) : TYPEFACES

  const pick = (id: Typeface) => { if (id !== value) onChange?.(id) }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = list[(i + d + list.length) % list.length]
    pick(next.id)
    e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tp="${next.id}"]`)?.focus()
  }

  return (
    <div className={`tp${compact ? ' tp-compact' : ''}`} role="radiogroup" aria-label={label}>
      {list.map((t, i) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t.label}
            tabIndex={on ? 0 : -1}
            className="tp-opt"
            data-tp={t.id}
            onClick={() => pick(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="tp-clock">{clock}</span>
            <span className="tp-title">{title}</span>
            <span className="tp-body">{body}</span>
            <span className="tp-name">
              {t.label}
              {on && <span className="tp-tick" aria-hidden="true"><Check size={14} /></span>}
            </span>
            {!compact && <span className="tp-note">{t.note}</span>}
          </button>
        )
      })}
    </div>
  )
}
