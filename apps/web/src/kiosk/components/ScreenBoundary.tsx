import { Component, type ReactNode } from 'react'
import { Placeholder } from './Placeholder'

// Catches a screen that fails to render — in practice, a code-split chunk that
// never arrives. React re-throws a rejected lazy() import during render, and an
// uncaught render error unmounts the tree to the root, so without this a kiosk that
// went offline after a deploy shows a white wall instead of the screen it already
// had. Scoped to the <Outlet> so the rail, topbar and banners survive: losing one
// screen is the cost code-splitting is supposed to have, losing the display is not.
//
// Rendered through Placeholder, the kiosk's centred full-screen state, rather than a
// card with its own spacing: a wall display can sit on this for hours, so it should
// look like the rest of the app.
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
      <Placeholder title="This screen couldn’t load" icon="cloud">
        <div className="muted ph-body">
          It’s usually a dropped connection right after an update. Everything else still works —
          pick another screen from the menu, or reload to try this one again.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </Placeholder>
    )
  }
}
