import { Component, type ReactNode } from 'react'

// Catches a screen that fails to render — in practice, a code-split chunk that
// never arrives. React re-throws a rejected lazy() import during render, and an
// uncaught render error unmounts the tree to the root, so without this a kiosk that
// went offline after a deploy shows a white wall instead of the screen it already
// had. Scoped to the <Outlet> so the rail, topbar and banners survive: losing one
// screen is the cost code-splitting is supposed to have, losing the display is not.
//
// There is deliberately no "try again" that re-renders in place. React caches a
// lazy() component's rejection for the life of the page, so re-rendering the same
// screen would fail again instantly and the button would read as broken. Reloading
// genuinely retries — the app shell is cached by the service worker, so it works
// offline — and tapping another rail item already works, because a different screen
// is a different lazy component with its own unresolved import.
export class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="card" style={{ margin: 16, padding: 24, textAlign: 'center' }}>
        <h2 style={{ marginTop: 0 }}>This screen couldn’t load</h2>
        <p className="muted">
          It’s usually a dropped connection right after an update. Everything else still works —
          pick another screen from the menu, or reload to try this one again.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    )
  }
}
