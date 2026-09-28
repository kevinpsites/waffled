import type { PlanningStep } from '../../lib/api'

// What a step shows before it is built, so the session is walkable end to end at any
// point and an unbuilt step still records a real answer.
export function StepPlaceholder({ step }: { step: PlanningStep }) {
  return (
    <div className="wp-placeholder">
      <div className="wp-placeholder-t">{step.title} is next up to be built</div>
      <div className="wp-placeholder-s">
        This step will read {step.requiresModule ? `your ${step.requiresModule} module` : 'what the app already knows'} —
        nothing here is typed twice. The session, its record and every other step already work,
        so you can walk the whole shape now.
      </div>
    </div>
  )
}
