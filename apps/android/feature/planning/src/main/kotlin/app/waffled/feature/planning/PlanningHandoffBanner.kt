package app.waffled.feature.planning

import app.waffled.feature.planning.api.PlanningStepHandoff

/** Which words an answered note carries: the corrected ones, not the stored `note`. */
object PlanningHandoffWords {
    fun of(note: PlanningStepHandoff, edited: Map<String, String>): String = edited[note.id] ?: note.note
}
