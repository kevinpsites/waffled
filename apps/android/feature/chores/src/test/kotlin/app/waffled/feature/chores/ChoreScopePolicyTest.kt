package app.waffled.feature.chores

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Translated from iOS `ChoreScopePolicyTests.swift`, plus the editor's scope rules that
 * live inline in iOS `ChoreEditSheet` (`instanceId(editing:)`, `targetBody`, and when
 * the "Which chores should change?" choice is asked).
 */
class ChoreScopePolicyTest {

    // ---- ChoreScopePolicyTests.swift ----------------------------------------------

    @Test
    fun `pending occurrence can be edited alone when repeat is unchanged`() {
        assertTrue(ChoreScopePolicy.allowsSingleOccurrence(status = "pending", repeatChanged = false))
    }

    @Test
    fun `repeat changes cannot apply to one occurrence`() {
        assertFalse(ChoreScopePolicy.allowsSingleOccurrence(status = "pending", repeatChanged = true))
    }

    @Test
    fun `settled occurrence cannot be edited or deleted alone`() {
        for (status in listOf("done", "awaiting")) {
            assertFalse(ChoreScopePolicy.allowsSingleOccurrence(status = status, repeatChanged = false))
            assertTrue(ChoreScopePolicy.explanation(status).contains("stays unchanged"))
        }
    }

    // ---- the editor's scope rules -------------------------------------------------

    @Test
    fun `a pending occurrence's explanation is the general rule`() {
        assertEquals(
            "Completed chores and items awaiting approval always stay unchanged.",
            ChoreScopePolicy.explanation("pending"),
        )
    }

    @Test
    fun `an edit anchored to the chore itself sends no occurrence`() {
        // The API answers 409 to a chore id sent as an instanceId.
        assertNull(ChoreScopePolicy.instanceId(id = "c1", choreId = "c1"))
        assertEquals("i1", ChoreScopePolicy.instanceId(id = "i1", choreId = "c1"))
    }

    @Test
    fun `saving asks for a scope only for a recurring chore with an occurrence`() {
        assertTrue(ChoreScopePolicy.asksOnSave(originalRrule = "FREQ=DAILY", instanceId = "i1"))
        assertFalse(ChoreScopePolicy.asksOnSave(originalRrule = null, instanceId = "i1"))
        assertFalse(ChoreScopePolicy.asksOnSave(originalRrule = "FREQ=DAILY", instanceId = null))
    }

    @Test
    fun `deleting asks for a scope for any recurring chore`() {
        assertTrue(ChoreScopePolicy.asksOnDelete(originalRrule = "FREQ=WEEKLY;BYDAY=MO"))
        assertFalse(ChoreScopePolicy.asksOnDelete(originalRrule = null))
    }

    @Test
    fun `a targeted body carries the scope and the occurrence`() {
        val body = buildJsonObject { put("title", JsonPrimitive("Dishes")) }

        val targeted = ChoreScopePolicy.target(body, ChoreScope.Following, instanceId = "i1")

        assertEquals(JsonPrimitive("Dishes"), targeted["title"])
        assertEquals(JsonPrimitive("following"), targeted["scope"])
        assertEquals(JsonPrimitive("i1"), targeted["instanceId"])
    }

    @Test
    fun `a targeted body without an occurrence omits instanceId`() {
        val targeted = ChoreScopePolicy.target(buildJsonObject { }, ChoreScope.All, instanceId = null)

        assertEquals(JsonPrimitive("all"), targeted["scope"])
        assertFalse("instanceId" in targeted)
    }

    @Test
    fun `the offered choices follow the policy`() {
        assertEquals(
            listOf(ChoreScope.This, ChoreScope.Following, ChoreScope.All),
            ChoreScopePolicy.choices(status = "pending", repeatChanged = false),
        )
        assertEquals(
            listOf(ChoreScope.Following, ChoreScope.All),
            ChoreScopePolicy.choices(status = "pending", repeatChanged = true),
        )
        assertEquals(
            listOf(ChoreScope.Following, ChoreScope.All),
            ChoreScopePolicy.choices(status = "done", repeatChanged = false),
        )
    }
}
