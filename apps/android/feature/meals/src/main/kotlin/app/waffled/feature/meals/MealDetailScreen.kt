package app.waffled.feature.meals

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddShoppingCart
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * One saved **plate**'s detail: its dishes grouped by role, plus add-to-list.
 *
 * Plates are REST-only by design, so this reloads over the network on appear rather than
 * reading a synced mirror. The [summary] it is handed renders immediately — a planned slot
 * already knows the plate's name and dishes — and the real plate replaces it once fetched.
 *
 * **Scope:** Cook Mode, the Meal Builder editor and scheduling belong to the recipes
 * feature and are not built here; [onCookDish] is the seam for the first of those.
 */
class MealDetailModel(
    private val api: MealsApi,
    summary: MealDTO,
    private val refreshBus: RefreshBus? = null,
) {
    private val _meal = MutableStateFlow(summary)
    private val _loading = MutableStateFlow(false)
    private val _message = MutableStateFlow<String?>(null)

    val meal: StateFlow<MealDTO> = _meal.asStateFlow()
    val loading: StateFlow<Boolean> = _loading.asStateFlow()
    val message: StateFlow<String?> = _message.asStateFlow()

    fun dismissMessage() {
        _message.value = null
    }

    /**
     * Reload the plate by id.
     *
     * A failed fetch keeps the summary on screen: it is a real, if thinner, version of the
     * same plate, and blanking the page would be strictly worse.
     */
    suspend fun reload() {
        _loading.value = true
        try {
            runCatching { api.meal(_meal.value.id) }.getOrNull()?.let { _meal.value = it }
        } finally {
            _loading.value = false
        }
    }

    /**
     * Put the whole plate's shopping on the list.
     *
     * Those rows land as `source='recipe'` — an explicit off-plan add that the weekly
     * rebuild deliberately never wipes. That is the whole difference from the derived
     * `auto` rows a plan rebuild owns, and getting the two backwards destroys user data.
     */
    suspend fun addToList() {
        val added = runCatching { api.addMealToGrocery(_meal.value.id) }.getOrNull()
        _message.value = when {
            added == null -> "Couldn't add this meal to the list."
            added == 1 -> "Added 1 item to the grocery list"
            else -> "Added $added items to the grocery list"
        }
        refreshBus?.bump(RefreshDomain.Lists)
    }

    /** The plate's dishes grouped by role, in plate order, empty roles dropped. */
    fun groups(meal: MealDTO): List<Pair<String, List<MealDishDTO>>> {
        val known = listOf("main", "side", "dessert")
        val ordered = known + meal.recipes.map { it.role }.filterNot { it in known }.distinct()
        return ordered.mapNotNull { role ->
            meal.dishes(role).sortedBy { it.sortOrder }.takeIf { it.isNotEmpty() }?.let { role to it }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MealDetailScreen(
    model: MealDetailModel,
    onOpenRecipe: (String) -> Unit,
    modifier: Modifier = Modifier,
    onCookDish: ((MealDishDTO) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val meal by model.meal.collectAsStateWithLifecycle()
    val loading by model.loading.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()

    LaunchedEffect(meal.id) { model.reload() }

    val groups = remember(meal) { model.groups(meal) }
    var menuOpen by remember { mutableStateOf(false) }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        PullToRefreshBox(
            isRefreshing = loading,
            onRefresh = { scope.launch { model.reload() } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 16.dp, end = 16.dp, top = 8.dp, bottom = WF.spacing.tabBarClearance,
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "header") {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                meal.emojis.takeIf { it.isNotEmpty() }?.joinToString("") ?: "🍽️",
                                style = TextStyle(fontSize = 28.sp),
                            )
                            Spacer(Modifier.size(6.dp))
                            Text(meal.name, style = WF.type.title, color = WF.colors.ink)
                            Spacer(Modifier.size(8.dp))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                PlanTag("🍽️ Serves ${meal.servings}")
                                val n = meal.recipeCount
                                PlanTag("🥘 $n ${if (n == 1) "dish" else "dishes"}")
                                meal.totalMinutes?.takeIf { it > 0 }?.let {
                                    PlanTag("🕐 ${MealsFormat.hoursMinutes(it)}")
                                }
                            }
                        }
                        Box {
                            Icon(
                                Icons.Filled.MoreVert,
                                contentDescription = "Meal actions",
                                tint = WF.colors.ink2,
                                modifier = Modifier
                                    .size(34.dp)
                                    .clip(RoundedCornerShape(WF.radius.pill))
                                    .clickable { menuOpen = true }
                                    .padding(7.dp),
                            )
                            MealRowMenu(
                                expanded = menuOpen,
                                onDismiss = { menuOpen = false },
                                items = listOf(
                                    MenuAction(
                                        "Add meal to list",
                                        Icons.Filled.AddShoppingCart,
                                        onClick = { scope.launch { model.addToList() } },
                                    ),
                                ),
                            )
                        }
                    }
                }
                item(key = "shopping") { PlateShopping(meal) }

                if (meal.recipes.isEmpty()) {
                    item(key = "empty") {
                        // A saved plate can genuinely have no dishes yet, which suppresses
                        // every role section — so say where dishes come from rather than
                        // showing a blank page.
                        WaffledCard(padding = 14.dp) {
                            Text(
                                "No dishes on this meal yet.",
                                style = WF.type.label,
                                color = WF.colors.ink,
                            )
                            Text(
                                "Dishes are added in the meal builder.",
                                style = WF.type.caption,
                                color = WF.colors.ink3,
                            )
                        }
                    }
                }

                groups.forEach { (role, dishes) ->
                    item(key = "role-$role") {
                        SectionLabel(role.replaceFirstChar { it.uppercase() })
                    }
                    items(dishes.size, key = { "$role-${dishes[it].recipeId}" }) { index ->
                        PlateDishRow(
                            dish = dishes[index],
                            onOpen = { onOpenRecipe(dishes[index].recipeId) },
                            onCook = onCookDish?.let { cook -> { cook(dishes[index]) } },
                        )
                    }
                }
            }
        }
        message?.let { text ->
            Toast(text, onDismiss = model::dismissMessage, modifier = Modifier.align(Alignment.TopCenter))
        }
    }
}

/**
 * The plate-level shopping claim.
 *
 * Counts dedupe shared ingredients across dishes — two dishes both wanting mayonnaise is
 * ONE thing to buy. With the pantry off there is no on-hand claim to make at all, which is
 * why a null `onHand` renders nothing rather than "0 on hand".
 */
@Composable
private fun PlateShopping(meal: MealDTO) {
    val onHand = meal.onHand
    when {
        onHand == null && meal.toBuy == 0 -> Unit
        meal.toBuy == 0 && onHand != null && onHand.total > 0 ->
            Text(
                "✓ Everything for this meal is on hand",
                style = WF.type.label,
                color = WF.colors.success,
            )
        meal.toBuy > 0 ->
            WaffledCard(padding = 12.dp) {
                Text("${meal.toBuy} to buy", style = WF.type.label, color = WF.colors.ink)
                // A bare count names nothing — the plate carries the actual shopping.
                Text(
                    meal.toBuyNames.joinToString(", "),
                    style = WF.type.caption,
                    color = WF.colors.ink3,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
    }
}

@Composable
private fun PlateDishRow(dish: MealDishDTO, onOpen: () -> Unit, onCook: (() -> Unit)?) {
    WaffledCard(padding = 12.dp) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen),
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WaffledEmojiTile(emoji = dish.emoji ?: "🍽️", frame = 40.dp, size = 20.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    dish.displayTitle,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    dish.totalMinutes?.let {
                        Text("🕐 ${MealsFormat.hoursMinutes(it)}", style = WF.type.caption, color = WF.colors.ink3)
                    }
                    dish.cook?.name?.let {
                        Text("👩‍🍳 $it", style = WF.type.caption, color = WF.colors.ink3)
                    }
                }
            }
            if (onCook != null) {
                Text(
                    "Cook",
                    style = WF.type.micro,
                    // On the solid neutral `ink` fill, `onInk` — it flips to warm off-white
                    // in dark, where literal white would vanish.
                    color = WF.colors.onInk,
                    modifier = Modifier
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .background(WF.colors.ink)
                        .clickable(onClick = onCook)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                )
            }
        }
    }
}

/** A transient confirmation, on the solid ink fill. */
@Composable
private fun Toast(text: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(4000)
        onDismiss()
    }
    Text(
        text,
        modifier = modifier
            .padding(top = 8.dp)
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(WF.colors.ink)
            .clickable(onClick = onDismiss)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        style = WF.type.label,
        color = WF.colors.onInk,
    )
}
