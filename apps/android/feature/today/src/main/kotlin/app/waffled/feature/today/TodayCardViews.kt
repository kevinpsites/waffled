package app.waffled.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.wfShadow1
import app.waffled.core.network.RestState
import app.waffled.core.sync.SyncedEvent
import java.time.ZoneId

/**
 * Thin rounded progress bar used in the summary cards — the port of iOS `ProgressBar`.
 *
 * Hand-rolled rather than Material3's `LinearProgressIndicator`: that draws a track gap
 * and an indeterminate animation this doesn't want, and its stop-indicator can't be turned
 * off without reaching into internals. Two capsules is the whole widget.
 */
@Composable
fun ProgressBar(
    value: Double,
    modifier: Modifier = Modifier,
    tint: Color = WF.colors.primary,
    track: Color = WF.colors.primary.copy(alpha = 0.18f),
    height: Dp = 7.dp,
) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .background(track, pill)
            .clip(pill),
    ) {
        Box(
            Modifier
                .fillMaxWidth(value.coerceIn(0.0, 1.0).toFloat())
                .fillMaxHeight()
                .background(tint, pill),
        )
    }
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

/**
 * Today's agenda, live from the local mirror.
 *
 * [events] arrives already filtered (per viewer) and bucketed (in the household's zone) by
 * `SyncManager` — this card must not re-derive either.
 */
@Composable
fun AgendaCard(
    events: List<SyncedEvent>,
    zone: ZoneId,
    onOpenCalendar: () -> Unit,
    onOpenEvent: (SyncedEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    WaffledCard(modifier = modifier, padding = 17.dp) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onOpenCalendar)
                .padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Today",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = TodayFormat.eventCount(events.size),
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink3,
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = WF.colors.ink3,
                modifier = Modifier.size(16.dp),
            )
        }

        if (events.isEmpty()) {
            Text(
                text = "Nothing scheduled today.",
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenCalendar)
                    .padding(vertical = 12.dp),
                style = TextStyle(fontSize = 14.sp),
                color = WF.colors.ink3,
            )
        } else {
            events.forEachIndexed { index, event ->
                AgendaEventRow(
                    event = event,
                    zone = zone,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onOpenEvent(event) }
                        .padding(vertical = 11.dp),
                )
                if (index < events.lastIndex) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(WF.colors.hair2),
                    )
                }
            }
        }
    }
}

/**
 * One agenda row: a colour bar, the title, and the local start time.
 *
 * Hand-rolled because the iOS twin lives in `Features/Shared/EventRow.swift` and Android
 * has no shared equivalent yet — `core:design` owns generic chrome, not event rows. When
 * the calendar feature lands one, this should collapse into it. It also deliberately omits
 * iOS's per-event palette and past-event fade: `eventPalette` is calendar state this
 * module can't reach, and guessing at it would put the wrong colour on the wrong event.
 */
@Composable
private fun AgendaEventRow(event: SyncedEvent, zone: ZoneId, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(4.dp)
                .height(30.dp)
                // iOS colours this bar from `sync.eventPalette`, which is calendar state
                // this module can't reach; the brand accent is the honest stand-in until
                // that palette exists on Android.
                .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill)),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = event.title,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = TodayFormat.eventTime(event, zone),
                style = TextStyle(fontSize = 12.sp),
                color = WF.colors.ink3,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Tonight's dinner
// ---------------------------------------------------------------------------

/**
 * Tonight's meal — a split media card, live from the meal plan.
 *
 * The buttons gate on [TonightMeal.isCookable] ("is there anything here to open", a recipe
 * OR a plate), never on the recipe alone: that is what told people "no recipe attached
 * yet" about a meal with three dishes.
 */
@Composable
fun TonightCard(
    meal: TonightMeal?,
    loaded: Boolean,
    onOpenRecipe: (TonightRecipe) -> Unit,
    onCookRecipe: (TonightRecipe) -> Unit,
    onOpenMeal: (TonightMeal) -> Unit,
    onCookMeal: (TonightMeal) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (meal == null) {
        // Don't render an empty state while the fetch is still in flight — that flash of
        // "No dinner planned" over a planned meal is the bug the loaded flag exists for.
        if (!loaded) return
        WaffledCard(modifier = modifier, padding = 15.dp) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🍽️", style = TextStyle(fontSize = 28.sp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "No dinner planned",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    Text(
                        text = "Add one from the capture bar",
                        style = TextStyle(fontSize = 12.5.sp),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
        return
    }

    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .clip(shape),
    ) {
        // Intrinsic height so the emoji panel matches the text column's height.
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(
                modifier = Modifier
                    .width(104.dp)
                    .fillMaxHeight()
                    .background(mealPanelBrush(meal.eatingOut)),
                contentAlignment = Alignment.Center,
            ) {
                Text(meal.emoji, style = TextStyle(fontSize = 36.sp))
            }
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 15.dp, vertical = 13.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = "TONIGHT · DINNER",
                    style = TextStyle(
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Black,
                        letterSpacing = 0.5.sp,
                    ),
                    color = FamilyColor.Person4.solid,
                )
                Text(text = meal.title, style = WF.type.serif(18.sp), color = WF.colors.ink)
                TodayFormat.mealSubtitle(meal)?.let {
                    Text(text = it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                }
            }
        }

        val recipe = meal.recipeSummary
        if (meal.isCookable && recipe != null) {
            TonightActions(
                secondary = "View recipe" to { onOpenRecipe(recipe) },
                primary = "👨‍🍳 Cook Mode" to { onCookRecipe(recipe) },
            )
        } else if (meal.isCookable) {
            // A Meal Builder plate. There's no single recipe to open, so "View meal" opens
            // the plate's detail and Cook takes the whole plate.
            TonightActions(
                secondary = "View meal" to { onOpenMeal(meal) },
                primary = "👨‍🍳 Cook meal" to { onCookMeal(meal) },
            )
        }
    }
}

/**
 * The tonight panel's wash.
 *
 * iOS hardcodes two literal gradients here; Android may not (see the design rules), so
 * these are tinted from the semantic tokens instead — `info` for an eating-out night,
 * `primary` for a cooking one. They adapt across themes, which the literals didn't.
 */
@Composable
private fun mealPanelBrush(eatingOut: Boolean): Brush {
    val hue = if (eatingOut) WF.colors.info else WF.colors.primary
    return Brush.linearGradient(listOf(hue.copy(alpha = 0.16f), hue.copy(alpha = 0.34f)))
}

@Composable
private fun TonightActions(
    secondary: Pair<String, () -> Unit>,
    primary: Pair<String, () -> Unit>,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp)),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        TonightButton(secondary.first, primary = false, Modifier.weight(1f), secondary.second)
        TonightButton(primary.first, primary = true, Modifier.weight(1f), primary.second)
    }
}

/**
 * A tonight-card action button.
 *
 * Hand-rolled rather than `WaffledPrimaryCTA`: that CTA is a full-width 14dp-tall page
 * action, and this is a half-width 10dp one inside a card, with an outlined secondary
 * variant the CTA has no equivalent of. White on the coral fill is correct — a saturated
 * coloured fill is the one place a literal white belongs.
 */
@Composable
private fun TonightButton(
    label: String,
    primary: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        modifier = modifier
            .background(if (primary) WF.colors.primary else WF.colors.panel, shape)
            .then(if (primary) Modifier else Modifier.border(1.dp, WF.colors.hair, shape))
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = if (primary) Color.White else WF.colors.ink,
        )
    }
}

// ---------------------------------------------------------------------------
// Chores + grocery (the 2-up summary pair)
// ---------------------------------------------------------------------------

@Composable
fun ChoresCard(
    people: List<TodayApi.PersonChores>,
    done: Int,
    total: Int,
    stars: Int,
    state: RestState,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    WaffledCard(modifier = modifier.clickable(onClick = onOpen), padding = 15.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "Family chores",
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
            Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
                if (people.isEmpty()) {
                    AvatarFromHex(colorHex = null, emoji = "🙂", size = 30.dp)
                } else {
                    people.take(3).forEach {
                        AvatarFromHex(
                            colorHex = it.colorHex,
                            emoji = it.avatarEmoji ?: "🙂",
                            size = 30.dp,
                        )
                    }
                }
            }
            if (total > 0) {
                ProgressBar(value = done.toDouble() / total)
                Row {
                    Text(
                        text = "$done of $total · ",
                        style = TextStyle(fontSize = 12.5.sp),
                        color = WF.colors.ink3,
                    )
                    Text(
                        text = "★ $stars",
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.gold,
                    )
                }
            } else {
                Text(
                    // "No chores today" is only true on an authoritative answer.
                    text = TodayFormat.unavailableCopy(state, empty = "No chores today"),
                    style = TextStyle(fontSize = 12.5.sp),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

@Composable
fun GroceryCard(
    remaining: Int,
    state: RestState,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    WaffledCard(modifier = modifier.clickable(onClick = onOpen), padding = 15.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = "Grocery",
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink2,
            )
            // A saved count still reads truthfully under its stale/offline notice.
            if (state.isAuthoritative || state.updatedAt != null) {
                Text(
                    text = "$remaining",
                    style = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Text(
                    text = TodayFormat.groceryUnit(remaining),
                    style = TextStyle(fontSize = 12.sp),
                    color = WF.colors.ink3,
                )
            } else {
                // Don't claim "0 items to buy" while the count is loading or unknown.
                Text(
                    text = TodayFormat.unavailableCopy(state, empty = "Loading…"),
                    style = TextStyle(fontSize = 12.5.sp),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The goal↔calendar review banner
// ---------------------------------------------------------------------------

/**
 * "N to review · M to link" — an AI-tinted card that opens the review screen. The AI hue
 * signals these are goal-progress confirmations rather than ordinary calendar rows.
 */
@Composable
fun ReviewEventsBanner(
    recapTitles: List<String>,
    suggestionTitles: List<String>,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.07f), shape)
            .border(1.dp, WF.colors.ai.copy(alpha = 0.22f), shape)
            .clip(shape)
            .clickable(onClick = onOpen)
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .background(
                    Brush.linearGradient(listOf(WF.colors.ai2, WF.colors.ai)),
                    RoundedCornerShape(WF.radius.sm),
                ),
            contentAlignment = Alignment.Center,
        ) {
            // White on a saturated AI gradient — the one case a literal white is right.
            Text("✨", style = TextStyle(fontSize = 18.sp), color = Color.White)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = TodayCards.reviewRecapTitle(recapTitles.size, suggestionTitles.size),
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Black),
                color = WF.colors.ink,
            )
            val preview = (recapTitles + suggestionTitles).take(3).joinToString(" · ")
            Text(
                text = preview.ifEmpty { "Tap to review & add to goals" },
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = WF.colors.ai,
            modifier = Modifier.size(18.dp),
        )
    }
}
