import type { AgendaEvent } from '../../lib/api'

// A scheduling-shape rhythm books an ordinary calendar event and points it back at
// itself (events.rhythm_id), so there is no rhythm entity to draw — only a marker
// saying this slot is somebody's rhythm. Same slot and weight as the ↻ repeat mark:
// a glyph before the title, never a badge or a second chip.
//
// Deliberately not follow-through language ("done", "on track", a streak). Getting
// the opportunity onto the calendar IS the outcome; we never ask whether it happened.
// That is the line between a rhythm and a goal.
export function RhythmMark({ event }: { event: AgendaEvent }) {
  if (!event.rhythmId) return null
  return (
    <span className="ev-rhythm" title="Part of a rhythm">
      🔁{' '}
    </span>
  )
}
