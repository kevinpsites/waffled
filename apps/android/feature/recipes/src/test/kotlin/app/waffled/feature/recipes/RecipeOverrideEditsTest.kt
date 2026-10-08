package app.waffled.feature.recipes

import app.waffled.core.network.WaffledJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Editing a recipe's `overrides` blob.
 *
 * `PATCH /api/recipes/:id` replaces the whole object, so every edit is read-modify-write.
 * The trap these cases exist to close is `explicitNulls = false`: a null property is
 * **omitted** from the request body, so serialising a data class would turn "I removed my
 * last step note" into "leave the step notes alone" — the note reappears on the next load
 * and nothing on screen explains why. Every assertion below is on the JSON that actually
 * goes on the wire, not on a model.
 */
class RecipeOverrideEditsTest {

    private val current = RecipeOverrides(
        meta = mapOf("cuisine" to "thai"),
        dietary = listOf("vegetarian"),
        addedTags = listOf("weeknight"),
        removedTags = listOf("spicy"),
        subs = mapOf("milk" to "oat milk"),
        stepNotes = mapOf("2" to "watch it"),
    )

    @Test
    fun addsAStepNoteAndKeepsEverythingElse() {
        val body = RecipeOverrideEdits.withStepNote(current, step = 3, note = " low heat ")
        val notes = body["stepNotes"]!!.jsonObject
        assertEquals("low heat", notes["3"]!!.jsonPrimitive.content)
        assertEquals("watch it", notes["2"]!!.jsonPrimitive.content)
        // The rest of the blob survives the replace.
        assertEquals("oat milk", body["subs"]!!.jsonObject["milk"]!!.jsonPrimitive.content)
        assertEquals("thai", body["meta"]!!.jsonObject["cuisine"]!!.jsonPrimitive.content)
        assertEquals("weeknight", body["addedTags"]!!.jsonArray[0].jsonPrimitive.content)
    }

    /**
     * The one that would fail silently: clearing the last step note has to reach the
     * server as an explicit null, not as a missing key.
     */
    @Test
    fun clearingTheLastStepNoteSendsAnExplicitNull() {
        val body = RecipeOverrideEdits.withStepNote(current, step = 2, note = "   ")
        assertEquals(JsonNull, body["stepNotes"])
        val wire = WaffledJson.encodeToString(body)
        assertTrue(wire.contains("\"stepNotes\":null"), wire)
    }

    @Test
    fun clearingOneOfSeveralStepNotesKeepsTheOthers() {
        val many = current.copy(stepNotes = mapOf("1" to "a", "2" to "b"))
        val body = RecipeOverrideEdits.withStepNote(many, step = 1, note = "")
        val notes = body["stepNotes"]!!.jsonObject
        assertEquals(1, notes.size)
        assertEquals("b", notes["2"]!!.jsonPrimitive.content)
    }

    /** Substitutions key on the lowercased, trimmed name — the same key the server uses. */
    @Test
    fun aSubstitutionKeysOnTheLowercasedName() {
        val body = RecipeOverrideEdits.withSub(current, "  Butter ", "olive oil")
        assertEquals("olive oil", body["subs"]!!.jsonObject["butter"]!!.jsonPrimitive.content)
        assertEquals("butter", RecipeOverrideEdits.subKey(" BUTTER "))
    }

    @Test
    fun clearingTheLastSubstitutionSendsAnExplicitNull() {
        val body = RecipeOverrideEdits.withSub(current, "milk", "")
        assertEquals(JsonNull, body["subs"])
    }

    @Test
    fun replacesTheUsersTagsAndDietary() {
        val body = RecipeOverrideEdits.withTags(current, listOf("quick"), listOf("vegan"))
        assertEquals("quick", body["addedTags"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals("vegan", body["dietary"]!!.jsonArray.single().jsonPrimitive.content)
        // removedTags is not what this editor touches, so it rides along unchanged.
        assertEquals("spicy", body["removedTags"]!!.jsonArray.single().jsonPrimitive.content)
    }

    @Test
    fun clearingEveryTagSendsAnExplicitNull() {
        val body = RecipeOverrideEdits.withTags(current, emptyList(), emptyList())
        assertEquals(JsonNull, body["addedTags"])
        assertEquals(JsonNull, body["dietary"])
    }

    /** A recipe that has never been edited starts from nothing rather than crashing. */
    @Test
    fun editsARecipeWithNoOverridesYet() {
        val body = RecipeOverrideEdits.withStepNote(null, step = 1, note = "salt first")
        assertEquals("salt first", body["stepNotes"]!!.jsonObject["1"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, body["subs"])
        assertEquals(JsonNull, body["meta"])
    }

    /** Every key is always present — an omitted one would mean "leave it". */
    @Test
    fun neverOmitsAKey() {
        val body = RecipeOverrideEdits.withStepNote(null, step = 1, note = "x")
        assertEquals(
            setOf("meta", "dietary", "addedTags", "removedTags", "subs", "stepNotes"),
            body.keys,
        )
    }
}
