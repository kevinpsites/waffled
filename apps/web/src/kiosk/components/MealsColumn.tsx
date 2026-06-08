import { Icon } from '../icons'

// Static until the meals/recipes domain (6.3) lands.
const WEEK: Array<{ day: string; emoji: string; title: string }> = [
  { day: 'Mon', emoji: '🐟', title: 'Sheet-Pan Salmon' },
  { day: 'Tue', emoji: '🌮', title: 'Chorizo Tacos' },
  { day: 'Wed', emoji: '🍛', title: 'Madras Lentils' },
  { day: 'Thu', emoji: '🍗', title: 'Honey-Garlic Wings' },
  { day: 'Fri', emoji: '🍝', title: 'Ravioli Bake' },
]

export function MealsColumn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      {/* tonight's dinner */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 112, background: 'linear-gradient(135deg,#f6d9c6,#e9b596)', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 14, bottom: 10 }} className="ai-tag">
            <Icon name="spark" />
            AI picked
          </div>
          <div style={{ position: 'absolute', right: 12, top: 10, fontSize: 34 }}>🍝</div>
        </div>
        <div style={{ padding: '14px 16px 15px', display: 'flex', flexDirection: 'column' }}>
          <div
            className="tiny"
            style={{ color: 'var(--lottie)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}
          >
            Tonight · Dinner
          </div>
          <div className="nk-serif" style={{ fontSize: 20, fontWeight: 600, margin: '3px 0 6px' }}>
            Ravioli &amp; Sausage Bake
          </div>
          <div className="tiny muted" style={{ display: 'flex', gap: 14 }}>
            <span>🕐 35 min</span>
            <span>🍽️ Serves 5</span>
          </div>
          <div style={{ display: 'flex', gap: 9, paddingTop: 13 }}>
            <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10 }}>
              View recipe
            </button>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center', fontSize: 14, padding: 10 }}>
              <Icon name="bag" />
              To list
            </button>
          </div>
        </div>
      </div>

      {/* this week's dinners */}
      <div className="card" style={{ padding: '15px 18px 8px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <div className="card-h" style={{ fontSize: 16 }}>
            This week’s dinners
          </div>
          <div style={{ marginLeft: 'auto' }} className="tiny muted">
            {WEEK.length} planned
          </div>
        </div>
        {WEEK.map((m) => (
          <div
            key={m.day}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 0', borderBottom: '1px solid var(--hair-2)' }}
          >
            <div className="tiny" style={{ width: 30, fontWeight: 700, color: 'var(--ink-2)' }}>
              {m.day}
            </div>
            <div style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{m.emoji}</div>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{m.title}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
