// Goal categories — reuse the person palette as the category palette (design).
export interface Category {
  emoji: string
  label: string
  color: string
  tint: string
  txt: string
}

export const CATEGORIES: Record<string, Category> = {
  physical: { emoji: '🏃', label: 'Physical', color: 'var(--person-3)', tint: 'var(--person-3-t)', txt: 'var(--person-3-tx)' },
  intellectual: { emoji: '📚', label: 'Intellectual', color: 'var(--person-1)', tint: 'var(--person-1-t)', txt: 'var(--person-1-tx)' },
  spiritual: { emoji: '🧘', label: 'Spiritual', color: 'var(--person-4)', tint: 'var(--person-4-t)', txt: 'var(--person-4-tx)' },
  creative: { emoji: '🎨', label: 'Creative', color: 'var(--person-2)', tint: 'var(--person-2-t)', txt: 'var(--person-2-tx)' },
  social: { emoji: '🤝', label: 'Social', color: 'var(--gold)', tint: 'var(--gold-t)', txt: 'var(--gold-d)' },
}

export const CATEGORY_KEYS = Object.keys(CATEGORIES)
