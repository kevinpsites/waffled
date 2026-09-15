import type { AgendaEvent } from '../../lib/api'
import { evVars } from '../../lib/event-color'
import '../../styles/planning-calendar.css'

export function chipWhen(e: AgendaEvent): string {
  if (e.allDay) return 'All day'
  const d = new Date(e.startsAt)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// One event as a planning step draws it. `.ev-tint` + `evVars` is the same chip painting every
// other calendar surface uses, so the unassigned/household case falls out of `useEventColor`.
// Shared by the Calendar step's week and Family night's event picker.
export function PlanningEventChip({ e, color, label, disabled, onClick }: {
  e: AgendaEvent
  color: string
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  const avatar = e.personEmoji ?? (e.personName ? e.personName.slice(0, 1).toUpperCase() : null)
  return (
    <button
      type="button"
      className={`wpc-chip ev-tint${avatar ? '' : ' bare'}`}
      style={evVars(color)}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="wpc-chip-w">{chipWhen(e)}</span>
      <span className="wpc-chip-t">{e.title}</span>
      {avatar && (
        <i className="wpc-chip-av" role="img" aria-label={e.personName ?? undefined}>
          {avatar}
        </i>
      )}
    </button>
  )
}
