package app.waffled.feature.recipes

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.floor

/** One editable ingredient row. */
@Immutable
data class EditIngredient(
    val uid: String,
    val amount: String = "",
    val unit: String = "",
    val name: String = "",
    val prepNote: String = "",
    val section: String = "",
) {
    val isBlank: Boolean get() = name.isBlank()

    companion object {
        fun of(dto: RecipeIngredientDTO, uid: String) = EditIngredient(
            uid = uid,
            amount = numberText(dto.amount),
            unit = dto.unit.orEmpty(),
            name = dto.name,
            prepNote = dto.prepNote.orEmpty(),
            section = dto.section.orEmpty(),
        )

        fun of(parsed: ParsedRecipe.Ing, uid: String) = EditIngredient(
            uid = uid,
            amount = numberText(parsed.amount),
            unit = parsed.unit.orEmpty(),
            name = parsed.name,
            prepNote = parsed.prepNote.orEmpty(),
            section = parsed.section.orEmpty(),
        )

        /** "2", not "2.0" — the field is what the cook typed, not a double's toString. */
        fun numberText(value: Double?): String = when {
            value == null -> ""
            value == floor(value) && !value.isInfinite() -> value.toInt().toString()
            else -> value.toString()
        }
    }
}

/**
 * One ingredient used at a step, with its own per-step amount — "½ the soy sauce here,
 * the rest later".
 */
@Immutable
data class StepPick(val ingredientUid: String, val amount: String = "")

/** One editable method step. */
@Immutable
data class EditStep(
    val uid: String,
    val instruction: String = "",
    val picks: List<StepPick> = emptyList(),
    /** Lines that matched no ingredient — kept verbatim rather than dropped. */
    val extra: List<String> = emptyList(),
    /** Total seconds for this step's optional timer; null = no timer. */
    val timerSeconds: Int? = null,
) {
    val isBlank: Boolean get() = instruction.isBlank()

    companion object {
        /**
         * Seed a step from saved or parsed data: match each "amount name" line back to an
         * ingredient (best effort) so the per-step amount stays editable, and keep the
         * unmatched lines as free extras rather than losing them.
         *
         * Longest ingredient name first, so "brown sugar" wins over "sugar" — otherwise a
         * step line reading "2 tbsp brown sugar" would file itself under the wrong row and
         * take the wrong amount with it.
         */
        fun seed(
            uid: String,
            instruction: String,
            ingredientLines: List<String>,
            ingredients: List<EditIngredient>,
            timerSeconds: Int? = null,
        ): EditStep {
            val named = ingredients.filterNot { it.isBlank }.sortedByDescending { it.name.length }
            val picks = mutableListOf<StepPick>()
            val extra = mutableListOf<String>()
            for (line in ingredientLines) {
                val lower = line.lowercase()
                val match = named.firstOrNull { lower.contains(it.name.lowercase()) }
                if (match == null) {
                    extra += line
                } else {
                    val at = lower.indexOf(match.name.lowercase())
                    picks += StepPick(match.uid, line.substring(0, at).trim())
                }
            }
            return EditStep(uid, instruction, picks, extra, timerSeconds)
        }
    }
}

/**
 * The whole recipe editor's state, and the body it sends — the testable half of iOS
 * `RecipeEditorView`.
 *
 * Kept out of the Composable so the two rules that fail silently are covered by tests:
 *
 *  1. **Clearing the photo needs `storageKey: null`, not just `imageUrl: null`.** The
 *     stored blob otherwise keeps winning and "remove the image" does nothing visible.
 *  2. **Every optional field goes out explicitly.** `PATCH /api/recipes/:id` replaces the
 *     recipe's content, and `WaffledJson` sets `explicitNulls = false` — so a data class
 *     would omit every field the user cleared, and clearing a cuisine or a prep time would
 *     silently leave the old value in place.
 */
@Immutable
data class RecipeEditorDraft(
    /** null ⇒ creating; otherwise the recipe being edited. */
    val editingId: String? = null,
    val emoji: String = "",
    val title: String = "",
    val servings: String = "4",
    val prep: String = "",
    val cook: String = "",
    /** The scalar Details fields, keyed by their wire name. */
    val meta: Map<String, String> = emptyMap(),
    val dietary: List<String> = emptyList(),
    val vegetables: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val notes: String = "",
    /** An external image link, or the resolved URL of an existing photo. */
    val imageUrl: String = "",
    /** Set once a picked photo has been uploaded; wins over [imageUrl]. */
    val storageKey: String? = null,
    val contentType: String? = null,
    val ingredients: List<EditIngredient> = emptyList(),
    val steps: List<EditStep> = emptyList(),
) {

    val canSave: Boolean get() = title.isNotBlank()

    /**
     * The create / save body.
     *
     * Every key is always present. An omitted key means "leave it alone", and this
     * endpoint replaces — so a field the user emptied must go out as an explicit null or
     * the old value survives with nothing on screen to explain it.
     */
    fun body(): JsonObject = buildJsonObject {
        put("title", title.trim())
        put("emoji", strOrNull(emoji))
        put("servings", servings.trim().toIntOrNull() ?: 4)
        put("prepTimeMinutes", intOrNull(prep))
        put("cookTimeMinutes", intOrNull(cook))
        for (field in SCALAR_FIELDS) put(field.key, strOrNull(meta[field.key].orEmpty()))
        put("dietary", strings(dietary))
        put("vegetables", strings(vegetables))
        put("tags", strings(tags))
        put("notes", strOrNull(notes))
        put("ingredients", ingredientsBody())
        put("steps", stepsBody())

        val link = imageUrl.trim()
        when {
            storageKey != null -> {
                put("storageKey", storageKey)
                if (contentType != null) put("contentType", contentType)
            }
            // No uploaded blob and no link → clear the image. Sending `storageKey: null`
            // (not just `imageUrl: null`) is what makes the server drop a previously
            // uploaded blob — otherwise the stored photo keeps winning and "removing" the
            // image does nothing.
            link.isEmpty() -> {
                put("imageUrl", JsonNull)
                put("storageKey", JsonNull)
                put("contentType", JsonNull)
            }

            else -> put("imageUrl", link)
        }
    }

    private fun ingredientsBody(): JsonArray = JsonArray(
        ingredients.filterNot { it.isBlank }.mapIndexed { i, g ->
            buildJsonObject {
                put("name", g.name.trim())
                put("sortOrder", i)
                put("amount", g.amount.trim().toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonNull)
                put("unit", strOrNull(g.unit))
                put("prepNote", strOrNull(g.prepNote))
                put("section", strOrNull(g.section))
            }
        },
    )

    private fun stepsBody(): JsonArray {
        val byUid = ingredients.associateBy { it.uid }
        return JsonArray(
            steps.filterNot { it.isBlank }.map { s ->
                val lines = buildList {
                    for (p in s.picks) {
                        val name = byUid[p.ingredientUid]?.name?.trim().orEmpty()
                        if (name.isEmpty()) continue
                        add(listOf(p.amount.trim(), name).filter { it.isNotEmpty() }.joinToString(" "))
                    }
                    addAll(s.extra)
                }
                buildJsonObject {
                    put("instruction", s.instruction.trim())
                    put("ingredients", strings(lines))
                    put("timerSeconds", s.timerSeconds?.let(::JsonPrimitive) ?: JsonNull)
                }
            },
        )
    }

    companion object {
        /** The scalar Details fields, in the order the editor lays them out. */
        val SCALAR_FIELDS = listOf(
            ScalarField("cuisine", "CUISINE", "Italian, Thai…"),
            ScalarField("protein", "PROTEIN", "chicken, beef…"),
            ScalarField("mealType", "MEAL TYPE", "dinner, breakfast…"),
            ScalarField("base", "BASE", "rice, pasta…"),
            ScalarField("effort", "EFFORT", "weeknight…"),
            ScalarField("cookMethod", "COOK METHOD", "sheet-pan, skillet…"),
            ScalarField("flavorProfile", "FLAVOR", "savory, spicy…"),
            ScalarField("collection", "COLLECTION", "Weeknight favorites…"),
        )

        /**
         * Curated common ingredient sections, merged with the household's own (a global
         * look across recipes) for the section-name autocomplete — canonical first.
         */
        val DEFAULT_SECTIONS = listOf(
            "Produce", "Meat", "Poultry", "Seafood", "Dairy", "Eggs", "Pantry",
            "Spices & seasonings", "Grains & pasta", "Canned goods", "Condiments & sauces",
            "Baking", "Bakery", "Frozen", "Herbs", "Nuts & seeds", "Beverages", "Sauce",
            "Garnish", "For serving",
        )

        /** A blank draft with one empty row of each, so the form is never an empty page. */
        fun create(uid: () -> String) = RecipeEditorDraft(
            ingredients = listOf(EditIngredient(uid())),
            steps = listOf(EditStep(uid())),
        )

        /** Seed from an existing recipe for editing. */
        fun edit(detail: RecipeDetailDTO, uid: () -> String): RecipeEditorDraft {
            val r = detail.recipe
            val ings = detail.ingredients.map { EditIngredient.of(it, uid()) }
                .ifEmpty { listOf(EditIngredient(uid())) }
            val steps = detail.steps
                .map { EditStep.seed(uid(), it.instruction, it.ingredients, ings, it.timerSeconds) }
                .ifEmpty { listOf(EditStep(uid())) }
            return RecipeEditorDraft(
                editingId = r.id,
                emoji = r.emoji.orEmpty(),
                title = r.title,
                servings = (r.servings ?: 4).toString(),
                prep = r.prepTimeMinutes?.toString().orEmpty(),
                cook = r.cookTimeMinutes?.toString().orEmpty(),
                meta = buildMap {
                    r.cuisine?.let { put("cuisine", it) }
                    r.protein?.let { put("protein", it) }
                    r.mealType?.let { put("mealType", it) }
                    r.base?.let { put("base", it) }
                    r.effort?.let { put("effort", it) }
                    r.cookMethod?.let { put("cookMethod", it) }
                    r.flavorProfile?.let { put("flavorProfile", it) }
                    r.collection?.let { put("collection", it) }
                },
                dietary = r.dietary.orEmpty(),
                vegetables = r.vegetables.orEmpty(),
                tags = r.tags.orEmpty(),
                notes = r.notes.orEmpty(),
                imageUrl = r.imageUrl.orEmpty(),
                ingredients = ings,
                steps = steps,
            )
        }

        /**
         * Hydrate from a parsed / dictated / photographed draft.
         *
         * Deliberately merges onto an existing draft rather than replacing it: the import
         * buttons sit inside a form the user may already have typed a title into.
         */
        fun hydrated(base: RecipeEditorDraft, parsed: ParsedRecipe, uid: () -> String): RecipeEditorDraft {
            val m = parsed.recipe
            val ings = parsed.ingredients.map { EditIngredient.of(it, uid()) }
                .ifEmpty { listOf(EditIngredient(uid())) }
            val steps = parsed.steps
                .map { EditStep.seed(uid(), it.instruction, it.ingredients.orEmpty(), ings) }
                .ifEmpty { listOf(EditStep(uid())) }
            return base.copy(
                title = m.title.ifBlank { base.title },
                emoji = m.emoji ?: base.emoji,
                servings = m.servings?.toString() ?: base.servings,
                notes = m.notes ?: base.notes,
                meta = base.meta + buildMap {
                    m.cuisine?.let { put("cuisine", it) }
                    m.protein?.let { put("protein", it) }
                    m.mealType?.let { put("mealType", it) }
                    m.base?.let { put("base", it) }
                    m.effort?.let { put("effort", it) }
                    m.cookMethod?.let { put("cookMethod", it) }
                    m.flavorProfile?.let { put("flavorProfile", it) }
                },
                dietary = m.dietary ?: base.dietary,
                vegetables = m.vegetables ?: base.vegetables,
                tags = m.tags ?: base.tags,
                ingredients = ings,
                steps = steps,
            )
        }

        private fun strOrNull(value: String): JsonElement =
            value.trim().takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull

        private fun intOrNull(value: String): JsonElement =
            value.trim().toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull

        private fun strings(values: List<String>): JsonArray =
            JsonArray(values.map(::JsonPrimitive))
    }
}

@Immutable
data class ScalarField(val key: String, val label: String, val placeholder: String)
