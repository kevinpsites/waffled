import { Component, type ReactNode } from 'react'

// A step body that throws must not take the session down with it. The route-level
// `ScreenBoundary` would replace the WHOLE planning screen — counter, agenda sheet and
// footer included — stranding you with no way to skip past the broken step. This boundary
// is tighter: the chrome survives, so a broken step costs that step and nothing else.
//
// Reset by giving it `key={step.key}`, so moving on tries again rather than inheriting
// the last step's failure.
export class StepErrorBoundary extends Component<{ children: ReactNode; title: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="wp-placeholder">
        <div className="wp-placeholder-t">{this.props.title} didn't load</div>
        <div className="wp-placeholder-s">
          Something went wrong reading this step. The rest of the session still works — skip it
          for now, or jump to another step from the counter above.
        </div>
      </div>
    )
  }
}
