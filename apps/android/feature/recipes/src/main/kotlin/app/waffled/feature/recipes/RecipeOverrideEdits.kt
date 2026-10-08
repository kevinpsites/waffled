package app.waffled.feature.recipes

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Read-modify-write of a recipe's `overrides` blob.
 *
 * `PATCH /api/recipes/:id` **replaces the whole object**, so every edit here starts from
 * the recipe's current overrides, changes one key, and sends it all back — exactly what
 * the web kiosk does.
 *
 * The reason this is a [JsonObject] builder rather than a `RecipeOverrides` data class:
 * `WaffledJson` sets `explicitNulls = false`, so a null property is **omitted** from the
 * body. Serialising the class would therefore turn "I removed my last step note" into
 * "leave the step notes alone" — the note would reappear on the next load, and nothing on
 * screen would explain why. Every cleared key here goes out as a real [JsonNull].
 *
 * Pure, so `RecipeOverrideEditsTest` can assert on the JSON that would go on the wire.
 */
object RecipeOverrideEdits {

    /** The key a substitution is filed under — the same lowercased name the server uses. */
    fun subKey(ingredientName: String): String = ingredientName.trim().lowercase()

    /**
     * Set (or, with a blank [note], clear) one step's note.
     *
     * Clearing the last note leaves an empty map, which is written as an explicit null:
     * "there are no step notes any more", not "don't touch the step notes".
     */
    fun withStepNote(current: RecipeOverrides?, step: Int, note: String): JsonObject {
        val notes = current?.stepNotes.orEmpty().toMutableMap()
        val trimmed = note.trim()
        if (trimmed.isEmpty()) notes.remove(step.toString()) else notes[step.toString()] = trimmed
        return body(current, stepNotes = notes)
    }

    /** Set (or, with a blank [value], clear) one ingredient's substitution. */
    fun withSub(current: RecipeOverrides?, ingredientName: String, value: String): JsonObject {
        val subs = current?.subs.orEmpty().toMutableMap()
        val key = subKey(ingredientName)
        val trimmed = value.trim()
        if (trimmed.isEmpty()) subs.remove(key) else subs[key] = trimmed
        return body(current, subs = subs)
    }

    /**
     * Replace the user's own tags and dietary flags.
     *
     * [addedTags] is the user-added set only — the server merges it with the source's own
     * tags — so writing the *merged* list back would silently re-add a tag the user just
     * removed from the source.
     */
    fun withTags(current: RecipeOverrides?, addedTags: List<String>, dietary: List<String>): JsonObject =
        body(current, addedTags = addedTags, dietary = dietary)

    /**
     * Rebuild the whole blob, overriding only the named parts.
     *
     * Every key is always present: an empty collection goes out as [JsonNull] (clear it),
     * a populated one as itself. Nothing is omitted, because an omitted key means "leave
     * it" and this endpoint replaces.
     */
    private fun body(
        current: RecipeOverrides?,
        meta: Map<String, String>? = current?.meta,
        dietary: List<String>? = current?.dietary,
        addedTags: List<String>? = current?.addedTags,
        removedTags: List<String>? = current?.removedTags,
        subs: Map<String, String>? = current?.subs,
        stepNotes: Map<String, String>? = current?.stepNotes,
    ): JsonObject = buildJsonObject {
        put("meta", stringMapOrNull(meta))
        put("dietary", stringListOrNull(dietary))
        put("addedTags", stringListOrNull(addedTags))
        put("removedTags", stringListOrNull(removedTags))
        put("subs", stringMapOrNull(subs))
        put("stepNotes", stringMapOrNull(stepNotes))
    }

    private fun stringListOrNull(values: List<String>?): JsonElement =
        if (values.isNullOrEmpty()) JsonNull
        else JsonArray(values.map { JsonPrimitive(it) })

    private fun stringMapOrNull(values: Map<String, String>?): JsonElement =
        if (values.isNullOrEmpty()) JsonNull
        else JsonObject(values.mapValues { (_, v) -> JsonPrimitive(v) })
}
