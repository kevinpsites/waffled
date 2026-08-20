import { WEEKDAYS } from './recurrence'

const WEEKDAY_LABELS: Record<string, string> = {
  SU: 'S', MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S',
}

/**
 * The day-of-week toggle row.
 *
 * Lives here rather than inside the event modal because it is the answer to a question
 * more than one screen asks. The rhythm editor was asking the same thing with a bare
 * "FREQ=MONTHLY;BYDAY=3SA" text box — a worse control for the identical decision, two
 * screens from a good one.
 *
 * `single` is what makes it safe for rhythms. An event may repeat on Monday AND Wednesday;
 * a rhythm's rule is DERIVED from its cadence, so "every week" plus `BYDAY=MO,WE` would
 * fire twice a period and assert something the cadence never said. In single mode picking
 * a day replaces the previous one instead of adding to it.
 *
 * An empty selection falls back to the anchor date's own weekday, matching `buildRrule`.
 */
export function WeekdayChips({
  value,
  weekday,
  onChange,
  single = false,
}: {
  value: string[]
  weekday: string
  onChange: (next: string[]) => void
  single?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {WEEKDAYS.map((d) => {
        const on = value.length ? value.includes(d) : d === weekday
        return (
          <button
            type="button"
            key={d}
            aria-pressed={on}
            aria-label={d}
            onClick={() => {
              if (single) {
                onChange([d])
                return
              }
              const base = value.length ? value : [weekday]
              onChange(base.includes(d) ? base.filter((x) => x !== d) : [...base, d])
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 999,
              border: `1.5px solid ${on ? 'var(--primary)' : 'transparent'}`,
              background: on ? 'var(--primary)' : 'var(--card-2)',
              color: on ? 'var(--on-accent)' : 'var(--ink)',
              font: 'inherit',
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {WEEKDAY_LABELS[d]}
          </button>
        )
      })}
    </div>
  )
}
