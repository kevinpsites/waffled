package app.waffled.feature.pantry

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledStatusBadge
import kotlinx.coroutines.launch

/**
 * The cross-module seams "Cook from your pantry" needs.
 *
 * Everything here belongs to **Recipes**, **Meals** or **Lists** — a recipe detail, the
 * week planner, a grocery add. Pantry owns only `api/pantry`, those modules are built in
 * parallel, and cross-feature dependencies aren't allowed, so each affordance is hoisted
 * to whoever wires the app together.
 *
 * A null hook **hides** its affordance rather than showing a dead control. The card
 * degrades gracefully: with nothing wired it still lists what's cookable and lets you
 * mark leftovers eaten, which is entirely pantry-side.
 */
data class CookHooks(
    /** Open a recipe. [startCooking] asks for Cook Mode straight away. */
    val onOpenRecipe: ((recipeId: String, title: String, emoji: String?, startCooking: Boolean) -> Unit)? = null,
    /** Open the recipe library filtered to an on-hand protein. */
    val onOpenProteinLibrary: ((protein: String) -> Unit)? = null,
    /** Open the AI week planner, seeded with the names that need using up. */
    val onPlanWeek: ((useUpNames: List<String>) -> Unit)? = null,
    /** Open whatever meal-slot picker Meals owns, for a ready-to-eat pantry item. */
    val onPlanLeftover: ((PantryRow) -> Unit)? = null,
    /** Add a name to the grocery list (a Lists route). */
    val onAddToGroceryList: (suspend (name: String) -> Unit)? = null,
)

/**
 * The "Cook from your pantry" entry card, shown at the top of the Pantry list.
 *
 * Gated on the **meals** module at the call site, and hidden once loaded if there is
 * genuinely nothing to show — an empty card is worse than no card.
 */
@Composable
fun CookFromPantryCard(
    model: PantryModel,
    hooks: CookHooks,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var cookable by remember { mutableStateOf(PantryApi.Cookable()) }
    var loaded by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { model.api.cookable() }.onSuccess { cookable = it }
        loaded = true
    }

    val meals = model.onHand.filter { it.isMeal }
    val useSoon = model.onHand.filter { it.isSoon }
    val empty = cookable.ready.isEmpty() && cookable.mains.isEmpty() &&
        meals.isEmpty() && useSoon.isEmpty()
    if (loaded && empty) return

    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "🍳 Cook from your pantry",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
        )
        Text(
            summary(cookable, meals.size + useSoon.size),
            style = WF.type.caption,
            color = WF.colors.ink3,
        )
        Text(
            "Plan from pantry",
            Modifier
                .fillMaxWidth()
                .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                .clip(RoundedCornerShape(WF.radius.pill))
                .clickable { open = true }
                .padding(vertical = 9.dp),
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            // White is correct on the saturated coral fill.
            color = Color.White,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }

    if (open) {
        CookFromPantrySheet(
            model = model,
            cookable = cookable,
            hooks = hooks,
            onDismiss = {
                open = false
                scope.launch { model.load() }
            },
        )
    }
}

private fun summary(cookable: PantryApi.Cookable, toUse: Int): String {
    val parts = buildList {
        if (cookable.ready.isNotEmpty()) add("${cookable.ready.size} ready")
        if (cookable.mains.isNotEmpty()) {
            add("${cookable.mains.size} main" + if (cookable.mains.size == 1) "" else "s")
        }
        if (toUse > 0) add("$toUse to use up")
    }
    return parts.ifEmpty { listOf("See what you can make") }.joinToString(" · ")
}

/**
 * The modal: what's ready to eat, what's makeable now, what an on-hand protein unlocks,
 * and what needs using up.
 *
 * `ready` and `mains` come from `api/pantry/cookable`; the leftovers and use-soon buckets
 * are computed on-device from rows already derived at load.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CookFromPantrySheet(
    model: PantryModel,
    cookable: PantryApi.Cookable,
    hooks: CookHooks,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var eaten by remember { mutableStateOf(emptySet<String>()) }
    var addedTo by remember { mutableStateOf(emptySet<String>()) }

    val mainNames = remember(cookable) { cookable.mains.mapNotNull { it.item?.name }.toSet() }
    val leftovers = model.onHand.filter { it.isMeal && it.id !in eaten }
    val loose = model.onHand.filter { !it.isMeal && it.isSoon && it.name !in mainNames }
    val useSoonNames = model.onHand.filter { it.isSoon }.map { it.name }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("Cook from your pantry", style = WF.type.title, color = WF.colors.ink)

            hooks.onPlanWeek?.let { planWeek ->
                PlanBanner(
                    useUpCount = useSoonNames.size,
                    onClick = { planWeek(useSoonNames.take(12)) },
                )
            }

            if (leftovers.isNotEmpty()) {
                Section("🕘 Tonight · no cooking", "Ready to eat") {
                    leftovers.forEach { row ->
                        LeftoverCard(
                            row = row,
                            onAteIt = {
                                eaten = eaten + row.id
                                scope.launch {
                                    model.consume(listOf(row.id to PantryApi.MODE_USED_UP))
                                }
                            },
                            onPlan = hooks.onPlanLeftover?.let { plan -> { plan(row) } },
                        )
                    }
                }
            }

            if (cookable.ready.isNotEmpty()) {
                Section("✓ You have everything", "Nothing to buy") {
                    cookable.ready.forEach { ready ->
                        ReadyCard(ready, hooks.onOpenRecipe)
                    }
                }
            }

            if (cookable.mains.isNotEmpty()) {
                Section("📈 You have the main", "On-hand proteins") {
                    cookable.mains.forEach { main ->
                        MainGroup(
                            main = main,
                            addedTo = addedTo,
                            hooks = hooks,
                            onAddMissing = { recipe ->
                                val add = hooks.onAddToGroceryList ?: return@MainGroup
                                addedTo = addedTo + recipe.recipeId
                                scope.launch { recipe.missing.forEach { add(it) } }
                            },
                        )
                    }
                }
            }

            if (loose.isNotEmpty()) {
                Section("🗑 Use up soon", "Loose items") {
                    PantryChipFlow {
                        loose.forEach { row ->
                            Row(
                                Modifier
                                    .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    row.name,
                                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                                    color = WF.colors.ink2,
                                )
                                row.expiryLabel?.let {
                                    Text(
                                        it,
                                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                                        color = row.expiryTone.color(),
                                    )
                                }
                            }
                        }
                    }
                }
            }

            if (leftovers.isEmpty() && cookable.ready.isEmpty() &&
                cookable.mains.isEmpty() && loose.isEmpty()
            ) {
                Text(
                    "Nothing to cook from just yet. Add what's on hand.",
                    Modifier.fillMaxWidth().padding(vertical = 30.dp),
                    style = WF.type.body,
                    color = WF.colors.ink3,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

@Composable
private fun Section(title: String, trailing: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            Spacer(Modifier.weight(1f))
            Text(trailing, style = WF.type.caption, color = WF.colors.ink3)
        }
        content()
    }
}

@Composable
private fun PlanBanner(useUpCount: Int, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.10f), shape)
            .border(1.dp, WF.colors.ai.copy(alpha = 0.25f), shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("✨", style = TextStyle(fontSize = 22.sp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                "Plan my week",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            Text(
                if (useUpCount == 0) {
                    "Build your dinners with AI"
                } else {
                    "Builds your week & uses up $useUpCount before they spoil"
                },
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink3,
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun CookCard(content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(11.dp),
    ) { content() }
}

@Composable
private fun LeftoverCard(row: PantryRow, onAteIt: () -> Unit, onPlan: (() -> Unit)?) {
    // A frozen leftover needs reheating; a fridge one doesn't. The section name is the
    // only clue we have, and it is the same clue the cook has.
    val fromFreezer = row.item.location.contains("freez", ignoreCase = true)
    CookCard {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Thumb(row)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    row.name,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WaffledStatusBadge(
                        if (fromFreezer) "Heat & serve" else "Ready to eat",
                        WF.colors.primary,
                    )
                    row.expiryLabel?.let { WaffledStatusBadge(it, WF.colors.warn) }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                CookPill("Ate it", filled = false, onClick = onAteIt)
                onPlan?.let { CookPill("Plan", filled = false, onClick = it) }
            }
        }
    }
}

@Composable
private fun ReadyCard(
    ready: PantryApi.CookReady,
    onOpenRecipe: ((String, String, String?, Boolean) -> Unit)?,
) {
    CookCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(40.dp)
                        .background(WF.colors.panel, RoundedCornerShape(10.dp))
                        .clip(RoundedCornerShape(10.dp))
                        .then(
                            if (onOpenRecipe != null) {
                                Modifier.clickable {
                                    onOpenRecipe(ready.recipeId, ready.title, ready.emoji, false)
                                }
                            } else {
                                Modifier
                            },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(ready.emoji ?: "🍽️", style = TextStyle(fontSize = 22.sp))
                }
                Text(
                    ready.title,
                    Modifier.weight(1f),
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                onOpenRecipe?.let { open ->
                    CookPill("Cook", filled = true) {
                        open(ready.recipeId, ready.title, ready.emoji, true)
                    }
                }
            }
            ready.expiringItem?.let {
                Text("Uses $it due soon", style = WF.type.caption, color = WF.colors.warn)
            }
            if (ready.have.isNotEmpty()) {
                PantryChipFlow(spacing = 6.dp) {
                    ready.have.forEach { WaffledStatusBadge("✓ $it", WF.colors.success) }
                }
            }
        }
    }
}

@Composable
private fun MainGroup(
    main: PantryApi.CookMain,
    addedTo: Set<String>,
    hooks: CookHooks,
    onAddMissing: (PantryApi.CookMainRecipe) -> Unit,
) {
    CookCard {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .then(
                        hooks.onOpenProteinLibrary?.let { open ->
                            Modifier.clickable { open(main.protein) }
                        } ?: Modifier,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    main.item?.name ?: main.protein.replaceFirstChar { it.uppercase() },
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.weight(1f))
                if (hooks.onOpenProteinLibrary != null) {
                    Text(
                        "${main.count} recipe" + (if (main.count == 1) "" else "s") + " ›",
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.primary,
                    )
                }
            }
            main.recipes.forEach { recipe ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(
                        Modifier
                            .weight(1f)
                            .then(
                                hooks.onOpenRecipe?.let { open ->
                                    Modifier.clickable {
                                        open(recipe.recipeId, recipe.title, null, false)
                                    }
                                } ?: Modifier,
                            ),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            recipe.title,
                            style = WF.type.label,
                            color = WF.colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "Have ${recipe.have} of ${recipe.total} · need " +
                                if (recipe.missing.size <= 1) {
                                    recipe.missing.firstOrNull() ?: "—"
                                } else {
                                    "${recipe.missing.size}"
                                },
                            style = TextStyle(fontSize = 11.5.sp),
                            color = WF.colors.ink3,
                            maxLines = 1,
                        )
                    }
                    if (hooks.onAddToGroceryList != null && recipe.missing.isNotEmpty()) {
                        val added = recipe.recipeId in addedTo
                        CookPill(
                            label = if (added) "✓ Added" else "+ List",
                            filled = added,
                            onClick = { if (!added) onAddMissing(recipe) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * A compact action pill.
 *
 * Hand-rolled rather than a Material `Button`: these sit two-to-a-column inside a list
 * row, and `Button`'s minimum touch frame plus its own colour scheme would both blow out
 * the row height and fight the palette.
 */
@Composable
private fun CookPill(label: String, filled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Text(
        label,
        Modifier
            .background(if (filled) WF.colors.primary else WF.colors.panel, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
        color = if (filled) Color.White else WF.colors.ink2,
    )
}
