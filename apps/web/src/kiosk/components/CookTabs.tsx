// The dish tab strip at the top of cook mode when you're cooking a whole plate.
// Each tab carries its dish's emoji, title and its OWN progress — advancing the BBQ
// chicken must not move the potato salad — and switching tabs returns you to exactly
// where you left that dish.
import '../../styles/cookmode.css'

export interface CookTabInfo {
  recipeId: string
  title: string
  emoji: string | null
  // Zero-based position within this dish's steps.
  stepIndex: number
  total: number
  done: boolean
}

export function CookTabs({
  tabs,
  activeIndex,
  onSelect,
}: {
  tabs: CookTabInfo[]
  activeIndex: number
  onSelect: (index: number) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div className="cm-tabs" role="tablist" aria-label="Dishes on this plate">
      {tabs.map((t, k) => {
        const active = k === activeIndex
        const progress = t.done ? 'Done' : t.total > 0 ? `Step ${t.stepIndex + 1} of ${t.total}` : 'No steps'
        return (
          <button
            key={t.recipeId}
            type="button"
            role="tab"
            aria-selected={active}
            className={`cm-tab${active ? ' cm-tab-on' : ''}${t.done ? ' cm-tab-done' : ''}`}
            onClick={() => onSelect(k)}
          >
            <span className="cm-tab-emoji" aria-hidden>
              {t.emoji ?? '🍽️'}
            </span>
            <span className="cm-tab-text">
              <span className="cm-tab-title">{t.title}</span>
              <span className="cm-tab-prog">{progress}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
