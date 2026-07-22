import { type Countdown } from '../../lib/api'

// A countdown rendered as an all-day-style chip in the day/week calendar views:
// emoji + title + a compact "Nd" / "Today" day badge. Event-sourced countdowns
// deep-link to their event; standalone ones open the inline editor (rename/move/
// remove). Birthday countdowns have no editing surface here (they come from the
// person's profile), so they stay informational (non-clickable).
export function CountdownChip({ c, onOpen }: { c: Countdown; onOpen?: (c: Countdown) => void }) {
  const clickable = !!onOpen && (c.source === 'event' || c.source === 'standalone')
  const badge = c.daysLeft <= 0 ? 'Today' : `${c.daysLeft}d`
  const color = c.color ?? '#8A7DBE'
  return (
    <div
      className={`cal-cd-ev${clickable ? ' clickable' : ''}`}
      style={{ background: `${color}22`, color }}
      onClick={clickable ? (e) => { e.stopPropagation(); onOpen!(c) } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={`${c.title} · ${badge}`}
    >
      <span className="cal-cd-emo" aria-hidden>{c.emoji ?? '🎉'}</span>
      <span className="cal-cd-t">{c.title}</span>
      <span className="cal-cd-n">{badge}</span>
    </div>
  )
}
