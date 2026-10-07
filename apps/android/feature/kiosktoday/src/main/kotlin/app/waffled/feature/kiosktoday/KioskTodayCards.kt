package app.waffled.feature.kiosktoday

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfShadow1
import app.waffled.core.model.Person
import app.waffled.core.network.RestState
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.lists.ListItemDTO
import app.waffled.feature.lists.PantryBadgeChip
import app.waffled.feature.today.RestStateNotice
import app.waffled.feature.today.TodayApi
import app.waffled.feature.today.TodayFormat
import app.waffled.feature.today.TonightMeal
import java.time.LocalDate
import java.time.ZoneId

/** iOS `KioskCard`: the shared card plus the hairline border the wall's cards carry. */
@Composable
internal fun KioskCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(WF.radius.lg)
    WaffledCard(modifier = modifier.border(1.dp, WF.colors.hair, shape), padding = 22.dp, content = content)
}

@Composable
internal fun CardHeader(title: String, trailing: String? = null, chevron: Boolean, onClick: (() -> Unit)? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Black), color = WF.colors.ink)
        Spacer(Modifier.weight(1f))
        if (trailing != null) {
            Text(trailing, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
        }
        if (chevron) Chevron()
    }
}

@Composable
private fun Chevron(tint: Color = WF.colors.ink3) {
    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
}

@Composable
private fun EmptyLine(text: String, size: Int = 16) {
    Text(
        text,
        modifier = Modifier.padding(vertical = 8.dp),
        style = TextStyle(fontSize = size.sp),
        color = WF.colors.ink3,
    )
}

// ---- banners ---------------------------------------------------------------------

@Composable
internal fun KioskBanner(
    title: String,
    subtitle: String,
    cta: String,
    accent: Color,
    icon: @Composable () -> Unit,
    iconFill: Brush,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .wfShadow1(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, accent, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(44.dp).background(iconFill, RoundedCornerShape(13.dp)),
            contentAlignment = Alignment.Center,
        ) { icon() }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Black), color = WF.colors.ink)
            Text(
                subtitle,
                style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(
            Modifier
                .background(WF.colors.primary, CircleShape)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // White on the saturated coral CTA, as on iOS.
            Text(cta, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = Color.White)
            Chevron(tint = Color.White)
        }
    }
}

@Composable
internal fun ApprovalsBannerIcon() =
    Icon(Icons.Filled.Verified, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))

@Composable
internal fun ReviewBannerIcon() =
    Icon(Icons.Filled.AutoAwesome, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))

// ---- agenda ------------------------------------------------------------------------

@Composable
internal fun AgendaWeekCard(
    week: List<Pair<LocalDate, List<SyncedEvent>>>,
    today: LocalDate,
    zone: ZoneId,
    members: Map<String, Person>,
    onOpenCalendar: () -> Unit,
    onOpenEvent: (SyncedEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    KioskCard(modifier) {
        CardHeader("This week", chevron = true, onClick = onOpenCalendar)
        Spacer(Modifier.height(4.dp))
        if (week.isEmpty()) {
            Text(
                "Nothing scheduled.",
                modifier = Modifier.padding(vertical = 20.dp),
                style = TextStyle(fontSize = 18.sp),
                color = WF.colors.ink3,
            )
        } else {
            LazyColumn(
                modifier = Modifier.padding(top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                week.forEach { (day, items) ->
                    item(key = day.toString()) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(
                                KioskTodayFormat.dayLabel(day, today),
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Black, letterSpacing = 0.6.sp),
                                color = WF.colors.ink3,
                            )
                            items.forEach { ev ->
                                EventRow(ev, zone, ev.personId?.let(members::get), onClick = { onOpenEvent(ev) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EventRow(ev: SyncedEvent, zone: ZoneId, person: Person?, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // iOS colours this from the calendar's event palette, which Android doesn't
        // expose yet; the person's colour (else the brand accent) is the honest stand-in.
        Box(
            Modifier
                .width(5.dp)
                .height(40.dp)
                .background(colorFromHex(person?.colorHex) ?: WF.colors.primary, RoundedCornerShape(WF.radius.pill)),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                ev.title,
                style = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(TodayFormat.eventTime(ev, zone), style = TextStyle(fontSize = 15.sp), color = WF.colors.ink3)
        }
        if (person != null) AvatarFromHex(person.colorHex, person.displayEmoji, size = 38.dp)
    }
}

// ---- tonight + week's dinners -------------------------------------------------------

@Composable
internal fun TonightKioskCard(
    meal: TonightMeal?,
    state: RestState,
    onRetry: () -> Unit,
    onOpenRecipe: () -> Unit,
    onCookRecipe: () -> Unit,
    onOpenMeal: () -> Unit,
    onCookMeal: () -> Unit,
) {
    KioskCard {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            CardHeader("Tonight's dinner", chevron = false)
            RestStateNotice(state, retry = onRetry)
            if (meal != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    // iOS paints literal peach / sky gradients here; the tint tokens are the
                    // closest theme-aware stand-ins (no food-tile token exists).
                    val fill = if (meal.eatingOut) {
                        listOf(WF.colors.infoT, WF.colors.info.copy(alpha = 0.35f))
                    } else {
                        listOf(WF.colors.primaryT, WF.colors.primary.copy(alpha = 0.35f))
                    }
                    Box(
                        Modifier.size(84.dp).background(Brush.linearGradient(fill), RoundedCornerShape(WF.radius.md)),
                        contentAlignment = Alignment.Center,
                    ) { Text(meal.emoji, style = TextStyle(fontSize = 40.sp)) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            meal.title,
                            style = WF.type.serif(26.sp),
                            color = WF.colors.ink,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        TodayFormat.mealSubtitle(meal)?.let {
                            Text(it, style = TextStyle(fontSize = 15.sp), color = WF.colors.ink3)
                        }
                    }
                }
                // Gated on isCookable, as on the phone card: a plate is cookable with no recipe.
                if (meal.isCookable && meal.recipeSummary != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        SecondaryButton("View recipe", Modifier.weight(1f), onOpenRecipe)
                        PrimaryButton("👨‍🍳 Cook Mode", Modifier.weight(1f), onCookRecipe)
                    }
                } else if (meal.isCookable && meal.mealId != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        SecondaryButton("View meal", Modifier.weight(1f), onOpenMeal)
                        PrimaryButton("👨‍🍳 Cook meal", Modifier.weight(1f), onCookMeal)
                    }
                }
            } else {
                KioskTodayRules.emptyCopy(state, "No dinner planned")?.let {
                    Text(
                        it,
                        modifier = Modifier.padding(vertical = 14.dp),
                        style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
    }
}

@Composable
private fun PrimaryButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .background(WF.colors.primary, RoundedCornerShape(WF.radius.md))
            .clip(RoundedCornerShape(WF.radius.md))
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = Color.White, maxLines = 1)
    }
}

@Composable
private fun SecondaryButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
            .clip(RoundedCornerShape(WF.radius.md))
            .clickable(onClick = onClick)
            .padding(vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink, maxLines = 1)
    }
}

@Composable
internal fun WeekDinnersCard(dinners: List<TodayApi.WeekEntry>, onOpenMeals: () -> Unit) {
    if (dinners.isEmpty()) return
    KioskCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CardHeader("This week's dinners", trailing = "${dinners.size} planned", chevron = true, onClick = onOpenMeals)
            val shown = dinners.take(6)
            Column {
                shown.forEachIndexed { idx, e ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpenMeals).padding(vertical = 11.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            KioskTodayFormat.dayShort(e.date),
                            modifier = Modifier.width(42.dp),
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Black),
                            color = WF.colors.ink3,
                        )
                        Text(e.recipe?.emoji ?: "🍽️", style = TextStyle(fontSize = 22.sp))
                        Text(
                            KioskTodayFormat.dinnerTitle(e),
                            modifier = Modifier.weight(1f),
                            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Chevron()
                    }
                    if (idx < shown.lastIndex) Hairline()
                }
            }
        }
    }
}

@Composable
private fun Hairline() = Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))

// ---- chores --------------------------------------------------------------------------

@Composable
internal fun FamilyChoresCard(
    people: List<TodayApi.PersonChores>,
    state: RestState,
    onRetry: () -> Unit,
    onOpenTasks: () -> Unit,
) {
    KioskCard {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            CardHeader("Family Chores", trailing = "Today", chevron = true, onClick = onOpenTasks)
            RestStateNotice(state, retry = onRetry)
            if (people.isEmpty()) {
                KioskTodayRules.emptyCopy(state, "No chores today")?.let { EmptyLine(it) }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    people.forEach { p -> PersonChoreRow(p, onOpenTasks) }
                }
            }
        }
    }
}

@Composable
private fun PersonChoreRow(p: TodayApi.PersonChores, onClick: () -> Unit) {
    val tint = colorFromHex(p.colorHex) ?: WF.colors.primary
    val frac = if (p.total > 0) p.done.toFloat() / p.total else 0f
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(46.dp)) {
                val stroke = 3.dp.toPx()
                val inset = stroke / 2
                val arcSize = Size(size.width - stroke, size.height - stroke)
                drawArc(tint.copy(alpha = 0.22f), 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                drawArc(tint, -90f, 360f * frac, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            }
            AvatarFromHex(p.colorHex, p.avatarEmoji ?: "🙂", size = 36.dp)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(p.name, style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Text(
                "${p.done} of ${p.total} done",
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        Text("★ ${p.stars}", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Black), color = WF.colors.gold)
    }
}

// ---- grocery -------------------------------------------------------------------------

@Composable
internal fun GroceryKioskCard(
    active: List<ListItemDTO>,
    state: RestState,
    onRetry: () -> Unit,
    onOpenLists: () -> Unit,
    onToggle: (ListItemDTO) -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    KioskCard(modifier) {
        CardHeader(
            "Grocery",
            trailing = KioskTodayRules.groceryTrailing(active.size, state),
            chevron = true,
            onClick = onOpenLists,
        )
        Spacer(Modifier.height(12.dp))
        RestStateNotice(state, retry = onRetry)
        if (active.isEmpty()) {
            KioskTodayRules.emptyCopy(state, "All bought ✓")?.let { EmptyLine(it) }
            Spacer(Modifier.weight(1f))
        } else {
            LazyColumn(Modifier.weight(1f)) {
                itemsIndexed(active, key = { _, it -> it.id }) { idx, item ->
                    GroceryRow(item, onClick = { onToggle(item) })
                    if (idx < active.lastIndex) Hairline()
                }
            }
        }
        Hairline()
        Row(
            modifier = Modifier.fillMaxWidth().clickable(onClick = onAdd).padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.AddCircle, contentDescription = null, tint = WF.colors.primary, modifier = Modifier.size(24.dp))
            Text("Add an item", style = TextStyle(fontSize = 17.sp), color = WF.colors.ink3)
        }
    }
}

@Composable
private fun GroceryRow(item: ListItemDTO, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (item.checked) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
            contentDescription = if (item.checked) "Checked" else "Not checked",
            tint = if (item.checked) WF.colors.primary else WF.colors.ink3,
            modifier = Modifier.size(24.dp),
        )
        // The pantry badge stacks under the name: beside it, it would truncate against
        // the quantity in a third-width column.
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                item.name,
                style = TextStyle(
                    fontSize = 17.sp,
                    textDecoration = if (item.checked) TextDecoration.LineThrough else TextDecoration.None,
                ),
                color = if (item.checked) WF.colors.ink3 else WF.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            item.pantry?.let { PantryBadgeChip(rowName = item.name, hit = it, dimmed = item.checked) }
        }
        item.quantity?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
        }
    }
}

/** Keeps a column's capture bar from stretching across a wide header. */
internal val CaptureBarMaxWidth = Modifier.widthIn(max = 400.dp)
