package app.waffled.feature.chores

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * What the chore editor puts on the wire — the twin of iOS `ChoreEditSheet.submit()`.
 *
 * Built as a `JsonObject` rather than a `@Serializable` data class on purpose:
 * `WaffledJson` sets `explicitNulls = false`, so a nullable property would be **omitted**
 * and the server would read "leave it alone" where the user meant "clear it". Clearing an
 * emoji, sending a chore back to up-for-grabs and turning a recurring chore into a
 * one-off all depend on the null actually being sent.
 */
class ChoreDraftTest {

    @Test
    fun `a minimal draft sends explicit nulls for everything it clears`() {
        val body = ChoreDraft(title = "Feed the dog").toBody(currencyCount = 1)

        assertEquals(JsonPrimitive("Feed the dog"), body["title"])
        assertEquals(JsonNull, body["emoji"])
        assertEquals(JsonNull, body["personId"])
        assertEquals(JsonNull, body["rrule"])
        assertEquals(JsonNull, body["dueTime"])
    }

    @Test
    fun `the title and emoji are trimmed`() {
        val body = ChoreDraft(title = "  Feed the dog  ", emoji = "  🐶 ").toBody(currencyCount = 1)

        assertEquals(JsonPrimitive("Feed the dog"), body["title"])
        assertEquals(JsonPrimitive("🐶"), body["emoji"])
    }

    @Test
    fun `a whitespace-only emoji clears rather than sending blanks`() {
        assertEquals(JsonNull, ChoreDraft(title = "x", emoji = "   ").toBody(currencyCount = 1)["emoji"])
    }

    @Test
    fun `a one-off carries its On date and no repeat rule`() {
        val body = ChoreDraft(
            title = "Feed the dog",
            repeat = ChoreRepeat.Once,
            dueOn = "2026-08-21",
        ).toBody(currencyCount = 1)

        assertEquals(JsonNull, body["rrule"])
        assertEquals(JsonPrimitive("2026-08-21"), body["dueOn"])
    }

    @Test
    fun `a recurring chore sends its rule and omits the On date`() {
        // The server ignores `dueOn` for a recurring chore; sending one is noise that
        // reads like an instruction.
        val body = ChoreDraft(
            title = "Feed the dog",
            repeat = ChoreRepeat.Weekly,
            days = setOf("MO", "FR"),
            dueOn = "2026-08-21",
        ).toBody(currencyCount = 1)

        assertEquals(JsonPrimitive("FREQ=WEEKLY;BYDAY=MO,FR"), body["rrule"])
        assertFalse(body.containsKey("dueOn"))
    }

    @Test
    fun `an optional due time goes on the wire as HH mm and null clears it`() {
        val timed = ChoreDraft(title = "x", dueTime = "16:30").toBody(currencyCount = 1)
        assertEquals(JsonPrimitive("16:30"), timed["dueTime"])

        val untimed = ChoreDraft(title = "x", dueTime = null).toBody(currencyCount = 1)
        assertEquals(JsonNull, untimed["dueTime"])
    }

    @Test
    fun `approval is never persisted for an adult assignee`() {
        // A parent doesn't need another parent's OK — the toggle is hidden for an adult,
        // and the value must not survive from an earlier assignee either.
        val body = ChoreDraft(
            title = "x",
            personId = "p1",
            requiresApproval = true,
            assigneeIsAdult = true,
        ).toBody(currencyCount = 1)

        assertEquals(JsonPrimitive(false), body["requiresApproval"])
    }

    @Test
    fun `approval is persisted for a child assignee`() {
        val body = ChoreDraft(
            title = "x",
            personId = "p1",
            requiresApproval = true,
            assigneeIsAdult = false,
        ).toBody(currencyCount = 1)

        assertEquals(JsonPrimitive(true), body["requiresApproval"])
    }

    @Test
    fun `the reward currency is sent only when the household has more than one`() {
        val single = ChoreDraft(title = "x", currencyKey = "stars").toBody(currencyCount = 1)
        assertFalse(single.containsKey("rewardCurrency"))

        val multiple = ChoreDraft(title = "x", currencyKey = "sticks").toBody(currencyCount = 2)
        assertEquals(JsonPrimitive("sticks"), multiple["rewardCurrency"])
    }

    @Test
    fun `an untouched edit keeps the chore's existing reward currency`() {
        // The trap: the currency is only "chosen" when someone taps a chip. Editing the
        // TITLE of a chore paid in a non-default currency must not silently move it to
        // the household default — so the seeded key has to survive a save nobody touched.
        val draft = ChoreDraft.from(
            ChoresApi.ChoreInstance(
                id = "i1",
                choreId = "c1",
                choreTitle = "Feed the dog",
                rewardCurrency = "sticks",
            ),
        )

        assertEquals(JsonPrimitive("sticks"), draft.toBody(currencyCount = 2)["rewardCurrency"])
    }

    @Test
    fun `a draft cannot be saved without a title`() {
        assertFalse(ChoreDraft(title = "   ").canSave)
        assertTrue(ChoreDraft(title = "Feed the dog").canSave)
    }

    @Test
    fun `a weekly draft cannot be saved until a day is picked`() {
        assertFalse(ChoreDraft(title = "x", repeat = ChoreRepeat.Weekly).canSave)
        assertTrue(ChoreDraft(title = "x", repeat = ChoreRepeat.Weekly, days = setOf("MO")).canSave)
    }

    @Test
    fun `editing an existing chore seeds the draft from the instance`() {
        val draft = ChoreDraft.from(
            ChoresApi.ChoreInstance(
                id = "i1",
                choreId = "c1",
                choreTitle = "Feed the dog",
                emoji = "🐶",
                personId = "p1",
                status = "pending",
                rewardAmount = 3,
                rewardCurrency = "stars",
                rrule = "FREQ=WEEKLY;BYDAY=MO,WE",
                dueOn = "2026-08-21",
                dueTime = "16:30",
                requiresApproval = true,
                requiresPhoto = true,
            ),
        )

        assertEquals("Feed the dog", draft.title)
        assertEquals("🐶", draft.emoji)
        assertEquals("p1", draft.personId)
        assertEquals(3, draft.rewardAmount)
        assertEquals(ChoreRepeat.Weekly, draft.repeat)
        assertEquals(setOf("MO", "WE"), draft.days)
        assertEquals("16:30", draft.dueTime)
        assertTrue(draft.requiresApproval)
        assertTrue(draft.requiresPhoto)
    }

    @Test
    fun `editing a one-off keeps it a one-off`() {
        // The trap: a blank rrule read as "daily" would silently convert a one-off into a
        // recurring chore the moment someone opened and saved it.
        val draft = ChoreDraft.from(
            ChoresApi.ChoreInstance(
                id = "i1",
                choreId = "c1",
                choreTitle = "Take out the bins",
                status = "pending",
                rrule = null,
                dueOn = "2026-08-21",
            ),
        )

        assertEquals(ChoreRepeat.Once, draft.repeat)
        assertEquals("2026-08-21", draft.toBody(currencyCount = 1)["dueOn"]?.let { (it as JsonPrimitive).content })
    }
}
