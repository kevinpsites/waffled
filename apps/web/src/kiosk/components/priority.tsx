// List-item priority: a small closed scale shared by the row marker and the
// edit modal's selector. 0 = normal, 1 = important, 2 = urgent. Higher priority
// sorts first (the API orders items by it), and marked items get a flag on the row.

export interface PriorityOption {
  value: 0 | 1 | 2
  label: string
  icon: string
}

export const PRIORITY_OPTIONS: PriorityOption[] = [
  { value: 0, label: 'Normal', icon: '' },
  { value: 1, label: 'Important', icon: '⚑' },
  { value: 2, label: 'Urgent', icon: '‼️' },
]

export function priorityMeta(p: number | undefined): PriorityOption {
  return PRIORITY_OPTIONS.find((o) => o.value === (p ?? 0)) ?? PRIORITY_OPTIONS[0]
}

// A flag badge shown on a list row for important/urgent items (nothing for normal).
export function PriorityFlag({ priority }: { priority?: number }) {
  const meta = priorityMeta(priority)
  if (meta.value === 0) return null
  return (
    <span className={`lpri lpri-${meta.value}`} title={meta.label} aria-label={meta.label}>
      {meta.icon}
    </span>
  )
}
