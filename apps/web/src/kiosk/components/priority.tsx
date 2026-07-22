// List-item priority: a 1–5 urgency scale shared by the row marker and the edit
// modal's selector. 1 = not urgent, 3 = normal (default), 5 = urgent. Higher
// priority sorts first (the API orders items by it); above-normal items (4–5) get
// a flag on the row so the important ones stand out.

export type PriorityValue = 1 | 2 | 3 | 4 | 5

export interface PriorityOption {
  value: PriorityValue
  label: string
  icon: string
}

export const PRIORITY_NORMAL: PriorityValue = 3

export const PRIORITY_OPTIONS: PriorityOption[] = [
  { value: 1, label: 'Not urgent', icon: '' },
  { value: 2, label: 'Low', icon: '' },
  { value: 3, label: 'Normal', icon: '' },
  { value: 4, label: 'High', icon: '⚑' },
  { value: 5, label: 'Urgent', icon: '‼️' },
]

export function priorityMeta(p: number | undefined): PriorityOption {
  return PRIORITY_OPTIONS.find((o) => o.value === (p ?? PRIORITY_NORMAL)) ?? PRIORITY_OPTIONS[2]
}

// A flag badge shown on a list row for above-normal items (High/Urgent). Normal and
// below carry no marker, so a flag always means "this one matters more".
export function PriorityFlag({ priority }: { priority?: number }) {
  const meta = priorityMeta(priority)
  if (!meta.icon) return null
  return (
    <span className={`lpri lpri-${meta.value}`} title={meta.label} aria-label={meta.label}>
      {meta.icon}
    </span>
  )
}
