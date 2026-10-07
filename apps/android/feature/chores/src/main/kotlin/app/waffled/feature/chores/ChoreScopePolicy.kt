package app.waffled.feature.chores

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** Which occurrences of a recurring chore an edit or delete reaches. */
enum class ChoreScope(val wire: String) {
    This("this"),
    Following("following"),
    All("all"),
}

/**
 * The edit-scope rules for a recurring chore — the port of iOS `ChoreScopePolicy` plus
 * the scope helpers inline in its `ChoreEditSheet`.
 *
 * Completed and awaiting-approval occurrences are history: the server refuses to change
 * them (409 `ChoreScopeError`), so "This chore only" is never offered for one.
 */
object ChoreScopePolicy {

    fun allowsSingleOccurrence(status: String?, repeatChanged: Boolean): Boolean =
        status == ChoresApi.STATUS_PENDING && !repeatChanged

    fun explanation(status: String?): String =
        if (status == ChoresApi.STATUS_PENDING) {
            "Completed chores and items awaiting approval always stay unchanged."
        } else {
            "The selected completed or awaiting-approval chore stays unchanged. " +
                "Only future pending chores are affected."
        }

    /** The scopes to offer, in the order the dialog lists them. */
    fun choices(status: String?, repeatChanged: Boolean): List<ChoreScope> =
        if (allowsSingleOccurrence(status, repeatChanged)) {
            listOf(ChoreScope.This, ChoreScope.Following, ChoreScope.All)
        } else {
            listOf(ChoreScope.Following, ChoreScope.All)
        }

    /**
     * The occurrence an edit is anchored to. A caller editing the chore itself passes the
     * chore's own id as the instance; the API answers 409 to a chore id sent as one.
     */
    fun instanceId(id: String, choreId: String): String? = id.takeIf { it != choreId }

    fun asksOnSave(originalRrule: String?, instanceId: String?): Boolean =
        originalRrule != null && instanceId != null

    fun asksOnDelete(originalRrule: String?): Boolean = originalRrule != null

    fun target(body: JsonObject, scope: ChoreScope, instanceId: String?): JsonObject = buildJsonObject {
        body.forEach { (key, value) -> put(key, value) }
        put("scope", JsonPrimitive(scope.wire))
        if (instanceId != null) put("instanceId", JsonPrimitive(instanceId))
    }
}
