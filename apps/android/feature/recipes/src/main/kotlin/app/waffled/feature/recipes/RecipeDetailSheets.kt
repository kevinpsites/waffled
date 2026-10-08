package app.waffled.feature.recipes

import app.waffled.core.model.HouseholdWeekStart
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.TextStyle as JavaTextStyle
import java.util.Locale

/**
 * The recipe detail's sheets — the Compose twins of the sheets at the bottom of
 * `apps/ios/.../Features/Meals/RecipeDetailView.swift`.
 *
 * All five are `ModalBottomSheet` (the Material3 control) with `WF.*` inside, rather than
 * hand-rolled overlays: the native sheet already handles the drag handle, the scrim, the
 * back gesture and the insets.
 */

/**
 * "This week" names the same seven days the planner shows, so it is cut on the
 * household's first day — otherwise a Monday household's Sunday lands in a different
 * week (and grocery list) than the planner was showing.
 */
internal object ScheduleWeek {
    fun start(today: LocalDate, firstDay: HouseholdWeekStart?, weekOffset: Int): LocalDate =
        (firstDay ?: HouseholdWeekStart.Sunday).weekStart(today).plusWeeks(weekOffset.toLong())
}

/**
 * Schedule a recipe (or a plate) onto a day + meal slot — a slot picker, a week you can
 * page through, and a 7-day grid. Tapping a day writes it and dismisses.
 *
 * [onSchedule] returning false keeps the sheet open: the server is the only thing that
 * knows whether the write landed, and a sheet that closes on failure claims otherwise.
 * The Meal Builder reuses this with its own `onSchedule` (a plate goes to a different
 * endpoint, which schedules every dish at once); everything else about the sheet is
 * identical, so it is reused rather than duplicated.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecipeScheduleSheet(
    title: String,
    onDismiss: () -> Unit,
    onSchedule: suspend (date: String, mealType: String) -> Boolean,
    /** The small-caps line above the title. The Meal Builder says "Schedule this meal". */
    eyebrow: String = "Schedule",
    /** The household's `week_start`; null until synced, read as Sunday. */
    householdWeekStart: HouseholdWeekStart? = null,
    today: LocalDate = LocalDate.now(),
) {
    val scope = rememberCoroutineScope()
    var meal by remember { mutableStateOf("dinner") }
    var weekOffset by remember { mutableIntStateOf(0) }
    var savingDay by remember { mutableStateOf<String?>(null) }

    val weekStart = remember(weekOffset, today, householdWeekStart) {
        ScheduleWeek.start(today, householdWeekStart, weekOffset)
    }
    val days = remember(weekStart) { (0..6).map { weekStart.plusDays(it.toLong()) } }
    val weekLabel = when (weekOffset) {
        0 -> "This week"
        1 -> "Next week"
        else -> "${weekStart.month.getDisplayName(JavaTextStyle.SHORT, Locale.getDefault())} ${weekStart.dayOfMonth}"
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(20.dp).padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SectionLabel(eyebrow)
                Text(title, style = WF.type.title, color = WF.colors.ink, maxLines = 2)
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("Meal")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (m in listOf("breakfast", "lunch", "dinner", "snack")) {
                        Text(
                            text = m.replaceFirstChar { it.uppercase() },
                            modifier = Modifier
                                .weight(1f)
                                .wfChip(m == meal)
                                .clickable { meal = m }
                                .padding(vertical = 9.dp),
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                            color = if (m == meal) WF.colors.primary else WF.colors.ink2,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                        )
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                RoundGlyph(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous week", weekOffset > 0) {
                    weekOffset = maxOf(0, weekOffset - 1)
                }
                Text(
                    weekLabel,
                    Modifier.weight(1f),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                    textAlign = TextAlign.Center,
                )
                RoundGlyph(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next week", true) { weekOffset += 1 }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (day in days) {
                    val key = day.toString()
                    val saving = savingDay == key
                    val shape = RoundedCornerShape(12.dp)
                    Column(
                        Modifier
                            .weight(1f)
                            // A per-person identity colour, one of the two documented
                            // cases for a literal colour, used here only as "this day is
                            // being written".
                            .background(
                                if (saving) FamilyColor.Person3.solid else WF.colors.card2,
                                shape,
                            )
                            .border(1.dp, WF.colors.hair, shape)
                            .clip(shape)
                            .clickable(enabled = savingDay == null) {
                                savingDay = key
                                scope.launch {
                                    if (onSchedule(key, meal)) onDismiss() else savingDay = null
                                }
                            }
                            .padding(vertical = 10.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            text = day.dayOfWeek.getDisplayName(JavaTextStyle.SHORT, Locale.getDefault())
                                .take(2).uppercase(),
                            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                            color = if (saving) WF.colors.onMedia else WF.colors.ink3,
                        )
                        Text(
                            text = "${day.dayOfMonth}",
                            style = WF.type.serif(17.sp, FontWeight.Bold),
                            color = if (saving) WF.colors.onMedia else WF.colors.ink,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RoundGlyph(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(34.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .background(WF.colors.panel, CircleShape)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = WF.colors.ink2, modifier = Modifier.size(16.dp))
    }
}

/**
 * "Add all, or pick specific ingredients" — the shopper may already have some on hand.
 *
 * Opens with every ingredient selected EXCEPT the ones the pantry actually matched. That
 * exception is the whole point: guessing was the old problem, and with the pantry module
 * on this is a real match against the household's inventory rather than a guess. Staples
 * are a different claim and stay CHECKED — [RecipeGroceryPick] owns the rule and the copy.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecipeGrocerySheet(
    title: String,
    ingredients: List<RecipeIngredientDTO>,
    onDismiss: () -> Unit,
    onAdd: (List<String>) -> Unit,
    /**
     * The servings scaler from the recipe behind this sheet. It covers the scaled
     * ingredient list, so formatting the raw amount here showed two different numbers for
     * the same ingredient — "2 cups flour" on the page, "1 cup flour" in the sheet.
     */
    ratio: Double = 1.0,
) {
    var selected by remember(ingredients) {
        mutableStateOf(RecipeGroceryPick.initialSelection(ingredients))
    }
    val pantryCount = remember(ingredients) { RecipeGroceryPick.pantryCount(ingredients) }
    val allOn = selected.size == ingredients.size

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(Modifier.fillMaxWidth()) {
            Column(
                Modifier.padding(horizontal = 20.dp).padding(bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                SectionLabel("Add to grocery list")
                Text(title, style = WF.type.title, color = WF.colors.ink, maxLines = 2)
                // Says how many it unchecked — a pre-unchecked box the user never touched
                // has to be accounted for, or the short list looks like a bug.
                Text(
                    text = RecipeGroceryPick.intro(pantryCount),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    color = if (pantryCount > 0) WF.colors.success else WF.colors.ink2,
                )
            }

            Text(
                text = if (allOn) "Select none" else "Select all",
                modifier = Modifier
                    .padding(horizontal = 20.dp)
                    .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable {
                        selected = if (allOn) emptySet() else ingredients.map { it.id }.toSet()
                    }
                    .padding(horizontal = 13.dp, vertical = 7.dp),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
            )

            LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 420.dp)) {
                items(ingredients, key = { it.id }) { ing ->
                    val on = ing.id in selected
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable {
                                selected = if (on) selected - ing.id else selected + ing.id
                            }
                            .padding(horizontal = 20.dp, vertical = 10.dp)
                            .alpha(if (on) 1f else 0.6f),
                        horizontalArrangement = Arrangement.spacedBy(11.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            imageVector = if (on) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                            contentDescription = null,
                            tint = if (on) WF.colors.primary else WF.colors.ink3.copy(alpha = 0.55f),
                            modifier = Modifier.size(20.dp),
                        )
                        val amount = RecipeAmount.line(ing.amount?.times(ratio), ing.unit)
                        if (amount.isNotEmpty()) {
                            Text(
                                amount,
                                Modifier.width(58.dp),
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink2,
                                textAlign = TextAlign.End,
                            )
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = ing.prepNote?.let { "${ing.name}, $it" } ?: ing.name,
                                style = TextStyle(fontSize = 15.sp),
                                color = WF.colors.ink,
                            )
                            // One hint slot, and the real match wins it.
                            when (RecipeGroceryPick.hint(ing)) {
                                RecipeGroceryPick.Hint.InPantry -> Text(
                                    "🥫 in your pantry",
                                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                                    color = WF.colors.success,
                                )

                                RecipeGroceryPick.Hint.Staple -> Text(
                                    "pantry staple — likely on hand",
                                    style = TextStyle(fontSize = 12.sp),
                                    color = WF.colors.ink3,
                                )

                                null -> Unit
                            }
                        }
                    }
                }
            }

            Box(Modifier.padding(horizontal = 20.dp, vertical = 14.dp)) {
                WaffledPrimaryCTA(
                    label = RecipeGroceryPick.addLabel(selected.size),
                    onClick = {
                        onAdd(selected.toList())
                        onDismiss()
                    },
                    isDisabled = selected.isEmpty(),
                )
            }
        }
    }
}

/** A small editor for one method step's note. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StepNoteSheet(
    stepNumber: Int,
    note: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var text by remember(stepNumber) { mutableStateOf(note.orEmpty()) }
    SheetForm(
        title = "Step note",
        onDismiss = onDismiss,
        onSave = { onSave(text); onDismiss() },
    ) {
        WaffledTextField(
            value = text,
            onValueChange = { text = it },
            label = "Note for step $stepNumber",
            placeholder = "e.g. the sauce splits if the pan is too hot",
            singleLine = false,
            minHeight = 120.dp,
        )
    }
}

/**
 * A small editor for one ingredient's substitution ("use X instead").
 *
 * Writes the recipe's `overrides.subs` blob — the same field the web kiosk edits, so it
 * flows straight into the substitution-aware grocery build. Empty = use the original.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IngredientSubSheet(
    ingredientName: String,
    sub: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var text by remember(ingredientName) { mutableStateOf(sub.orEmpty()) }
    SheetForm(
        title = "Substitution",
        onDismiss = onDismiss,
        onSave = { onSave(text); onDismiss() },
    ) {
        WaffledTextField(
            value = text,
            onValueChange = { text = it },
            label = "Substitute for $ingredientName",
            placeholder = "e.g. olive oil",
        )
        Text(
            "Swaps this ingredient in the recipe and on the grocery list. Leave empty to use the original.",
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )
        if (text.isNotBlank()) {
            Text(
                text = "↺ Use the original ($ingredientName)",
                modifier = Modifier.clickable { onSave(""); onDismiss() },
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ai,
            )
        }
    }
}

/**
 * A lightweight tags + dietary editor — add / remove free tags, toggle common dietary
 * flags. Not a full metadata editor; just the bits worth doing on a phone.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TagsEditorSheet(
    tags: List<String>,
    dietary: List<String>,
    onDismiss: () -> Unit,
    onSave: (List<String>, List<String>) -> Unit,
) {
    var current by remember { mutableStateOf(tags) }
    var flags by remember { mutableStateOf(dietary.toSet()) }
    var newTag by remember { mutableStateOf("") }

    val options = remember(flags) { (COMMON_DIETARY + flags).distinct().sorted() }

    fun addTag() {
        val t = newTag.trim().lowercase()
        if (t.isNotEmpty() && t !in current) current = current + t
        newTag = ""
    }

    SheetForm(
        title = "Tags & dietary",
        onDismiss = onDismiss,
        onSave = { onSave(current, flags.sorted()); onDismiss() },
    ) {
        SectionLabel("Tags")
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            for (t in current) {
                TagChip("#$t", onRemove = { current = current.filterNot { it == t } })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            WaffledTextField(
                value = newTag,
                onValueChange = { newTag = it },
                placeholder = "Add a tag…",
                modifier = Modifier.weight(1f),
            )
            Box(
                Modifier
                    .size(44.dp)
                    .background(
                        if (newTag.isBlank()) WF.colors.ink3 else WF.colors.primary,
                        CircleShape,
                    )
                    .clip(CircleShape)
                    .clickable(enabled = newTag.isNotBlank()) { addTag() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Add,
                    "Add tag",
                    // White on a saturated coloured fill.
                    tint = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        SectionLabel("Dietary")
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            for (d in options) {
                val on = d in flags
                Text(
                    text = d,
                    modifier = Modifier
                        .wfChip(on, WF.colors.ai)
                        .clickable { flags = if (on) flags - d else flags + d }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = if (on) WF.colors.ai else WF.colors.ink2,
                )
            }
        }
    }
}

private val COMMON_DIETARY = listOf(
    "vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "keto", "paleo", "low-carb",
)

/**
 * The shared shape of the small editor sheets: a title, a scrolling form, and a
 * Cancel/Save pair. The pair uses the shared CTAs rather than a hand-rolled toolbar —
 * `ModalBottomSheet` has no toolbar slot the way a SwiftUI `NavigationStack` does.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SheetForm(
    title: String,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, style = WF.type.title, color = WF.colors.ink)
            content()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) { WaffledSecondaryCTA("Cancel", onDismiss) }
                Box(Modifier.weight(1f)) {
                    WaffledPrimaryCTA("Save", onSave)
                }
            }
        }
    }
}
