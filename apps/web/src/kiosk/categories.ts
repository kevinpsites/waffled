// Goal categories — reuse the person palette as the category palette (design).
export interface Category {
  emoji: string
  label: string
  color: string
  tint: string
  txt: string
}

export const CATEGORIES: Record<string, Category> = {
  physical: { emoji: '🏃', label: 'Physical', color: 'var(--person-3)', tint: 'var(--person-3-t)', txt: '#167a4a' },
  intellectual: { emoji: '📚', label: 'Intellectual', color: 'var(--person-1)', tint: 'var(--person-1-t)', txt: '#1559b8' },
  spiritual: { emoji: '🧘', label: 'Spiritual', color: 'var(--person-4)', tint: 'var(--person-4-t)', txt: '#6a3fc4' },
  creative: { emoji: '🎨', label: 'Creative', color: 'var(--person-2)', tint: 'var(--person-2-t)', txt: '#b22f66' },
  social: { emoji: '🤝', label: 'Social', color: 'var(--gold)', tint: '#fdecd6', txt: '#d98a1c' },
}

export const CATEGORY_KEYS = Object.keys(CATEGORIES)
