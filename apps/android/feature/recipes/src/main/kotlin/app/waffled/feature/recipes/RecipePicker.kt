package app.waffled.feature.recipes

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.waffled.core.design.WF
import app.waffled.core.model.RecipeRef

/**
 * **The seam.** How another feature picks something out of the recipe library without
 * depending on anything inside it.
 *
 * The Meals planner needs to fill a slot, and a planned slot can hold **either** a single
 * recipe or a whole plate — `WeekEntryDTO.isMealBacked` exists precisely because deciding
 * by `recipeId != null` broke four surfaces at once on the web. So the picker offers both,
 * and the two callbacks speak only in types the planner already has:
 *
 *  - a recipe comes back as [RecipeRef], the shared shape in `core:model`;
 *  - a **plate** comes back as `(mealId, name)`, two primitives — because `core:model`
 *    has no plate-shaped equivalent of `RecipeRef` and is frozen. See the report: a
 *    `MealRef` there is the one thing that would make this seam symmetrical.
 *
 * Omit [onPickMeal] and plates are hidden rather than rendered as a card that does nothing
 * when tapped.
 *
 * The picker IS the library screen in pick mode — deliberately one screen, not two: a
 * picker that browses differently from the library is a second thing to learn, and search,
 * filters and the type filter would drift apart.
 */
@Composable
fun RecipePicker(
    model: RecipesModel,
    onPickRecipe: (RecipeRef) -> Unit,
    modifier: Modifier = Modifier,
    onPickMeal: ((mealId: String, name: String) -> Unit)? = null,
    /**
     * A plate to leave out — the one currently being built. Adding a plate to itself
     * flattens it into itself, silently renumbering every dish it already has.
     */
    excludeMealId: String? = null,
) {
    RecipesLibraryScreen(
        model = model,
        modifier = modifier,
        onPickRecipe = { onPickRecipe(it.toRef()) },
        onPickMeal = onPickMeal?.let { pick -> { meal: MealDTO -> pick(meal.id, meal.name) } },
        excludeMealId = excludeMealId,
    )
}

/**
 * The same picker in a bottom sheet — what the Meal Builder's "＋ Add a side" opens, and
 * the shape a host-supplied slot usually wants.
 *
 * [title] is the role's own add label ("Add a side"), so the sheet says which slot is
 * being filled.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecipePickerSheet(
    model: RecipesModel,
    title: String,
    onDismiss: () -> Unit,
    onPickRecipe: (RecipeRef) -> Unit,
    onPickMeal: ((mealId: String, name: String) -> Unit)? = null,
    excludeMealId: String? = null,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Text(
            text = title,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            style = WF.type.title,
            color = WF.colors.ink,
        )
        // Bounded, never `fillMaxSize()`: the library is a LazyVerticalGrid and a
        // ModalBottomSheet's column wraps its content, so an unbounded lazy child measures
        // at zero height (or blows up on an infinite constraint) and the picker comes up
        // empty. This is the first thing to check on a device.
        Box(Modifier.fillMaxWidth().fillMaxHeight(0.9f)) {
            RecipePicker(
                model = model,
                onPickRecipe = { onPickRecipe(it); onDismiss() },
                onPickMeal = onPickMeal?.let { pick ->
                    { id: String, name: String -> pick(id, name); onDismiss() }
                },
                excludeMealId = excludeMealId,
            )
        }
    }
}
