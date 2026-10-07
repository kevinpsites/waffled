package app.waffled.feature.family

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex
import app.waffled.core.model.Person
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate
import java.time.ZoneId

/**
 * Content on the spotlight that other features own, passed in by `app` so this module
 * depends on none of them. Each defaults to drawing nothing (or a plain fallback).
 */
class PersonSpotlightSlots(
    /**
     * The Rewards module's `SavingTowardCard` (+ its picker and redeem). [overview] is the
     * raw `/overview` response — decode `RewardsApi.PersonRewardOverview` from it. Call
     * `onChanged` after a pin or redeem so the spotlight reloads.
     */
    val savingToward: @Composable (overview: JsonObject, canRedeem: Boolean, onChanged: () -> Unit) -> Unit =
        { _, _, _ -> },
    /** A goal category's identity colour — the Goals module's `goalCategoryColor`. */
    val goalTint: @Composable (category: String?) -> Color = { WF.colors.primary },
    /** The Chores module's check row; null draws a plain fallback row. */
    val choreRow: (@Composable (FamilyApi.ChoreInstance, onToggle: () -> Unit) -> Unit)? = null,
    /** Weekly Planning's "this week's one thing" card (Wave E). */
    val planningFocus: @Composable (FamilyApi.PlanningFocus) -> Unit = {},
    /** The Waffled-Bite entry card; `app` gates it on the `waffledBites` module. */
    val waffledBite: (@Composable (personId: String, firstName: String) -> Unit)? = null,
)

/**
 * The per-person spotlight — tap anyone on the Family hub. The port of iOS `PersonView`
 * (phone layout): stats, saving-toward, their day (events + chores), whole-person
 * balance, goals, currencies and recent ledger, and reward redemptions.
 *
 * [onAward] / [onTrade] are null when the action isn't offered (no `reward.grant`, or no
 * conversions); `app` shows the sheets and reloads [model] after.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonScreen(
    model: PersonOverviewModel,
    me: Person?,
    eventsByDay: Map<LocalDate, List<SyncedEvent>>,
    zone: ZoneId,
    onOpen: (HubRoute) -> Unit,
    onOpenEvent: (SyncedEvent) -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
    onAward: (() -> Unit)? = null,
    onTrade: (() -> Unit)? = null,
    slots: PersonSpotlightSlots = PersonSpotlightSlots(),
) {
    val s by model.state.collectAsStateWithLifecycle()
    val coroutines = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val ov = s.overview
    val firstName = PersonSpotlight.firstName(ov)
    val today = remember(zone) { LocalDate.now(zone) }
    val events = remember(eventsByDay, model.personId, today) {
        PersonSpotlight.eventsFor(model.personId, eventsByDay, today)
    }
    val reload: () -> Unit = { coroutines.launch { model.load() } }

    LaunchedEffect(model.personId) { model.load() }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { coroutines.launch { refreshing = true; model.load(); refreshing = false } },
        modifier = modifier.fillMaxSize().background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(top = 8.dp, bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Header(ov)
            FamilyRestNotice(visible = s.error, onRetry = reload)
            slots.waffledBite?.invoke(model.personId, firstName)
            ov?.planningFocus?.let { slots.planningFocus(it) }
            StatCards(s, slots, onOpen)
            ov?.raw?.let { raw -> slots.savingToward(raw, PersonSpotlight.maySpend(me, model.personId), reload) }

            SectionLabel("${firstName.uppercase()}’S DAY")
            DayList(
                events = events,
                chores = s.chores,
                loading = s.loading,
                zone = zone,
                choreRow = slots.choreRow,
                onOpenEvent = onOpenEvent,
                onToggle = { c ->
                    if (PersonSpotlight.needsPhotoToFinish(c)) onOpen(HubRoute.Chores)
                    else coroutines.launch { model.toggleChore(c.id) }
                },
            )

            if (ov != null) {
                if (ov.categoryBalance.any { it.goalCount > 0 }) BalanceCard(ov, slots)
                if (ov.goals.isNotEmpty()) GoalsCard(ov, firstName, slots, onOpen)
                CurrenciesCard(ov, onAward, onTrade)
                if (ov.redemptions.isNotEmpty()) RedemptionsCard(ov)
            }
            AddButton(firstName, onAdd)
        }
    }
}

// ---- header -------------------------------------------------------------------

@Composable
private fun Header(ov: FamilyApi.PersonOverview?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        AvatarFromHex(ov?.person?.colorHex, ov?.person?.avatarEmoji ?: "🙂", size = 56.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(ov?.person?.name ?: " ", style = WF.type.serif(28.sp), color = WF.colors.ink)
            Text(
                PersonSpotlight.subtitle(ov),
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        if (ov != null) {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PersonSpotlight.balances(ov).forEach { b -> BalanceLine(b, WF.colors.ink) }
            }
        }
    }
}

@Composable
private fun BalanceLine(b: SpotlightBalance, amountColor: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(b.symbol, style = TextStyle(fontSize = 15.sp))
        Text("${b.amount}", style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Black), color = amountColor)
        Text(
            b.label.lowercase(),
            maxLines = 1,
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
    }
}

// ---- stat cards ---------------------------------------------------------------

@Composable
private fun StatCards(s: PersonOverviewSnapshot, slots: PersonSpotlightSlots, onOpen: (HubRoute) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        val total = s.chores.size
        StatCard(
            title = "Today’s chores",
            big = if (total == 0) "None" else "${s.choresDone} of $total",
            frac = if (total == 0) 0.0 else s.choresDone.toDouble() / total,
            tint = FamilyColor.Person3.solid,
            modifier = Modifier.weight(1f),
            onClick = { onOpen(HubRoute.Chores) },
        )
        val g = s.overview?.goals?.firstOrNull()
        if (g != null) {
            StatCard(
                title = g.title,
                big = "${PersonSpotlight.fmt(g.progress)}/${PersonSpotlight.fmt(g.target)}",
                frac = (g.pct ?: 0) / 100.0,
                tint = slots.goalTint(g.category),
                modifier = Modifier.weight(1f),
                onClick = { onOpen(HubRoute.Goal(g.id)) },
            )
        } else {
            StatCard("Goals", "—", 0.0, WF.colors.ink3, Modifier.weight(1f)) { onOpen(HubRoute.Goals) }
        }
    }
}

@Composable
private fun StatCard(
    title: String,
    big: String,
    frac: Double,
    tint: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        modifier
            .clip(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
        Text(big, maxLines = 1, style = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Black), color = WF.colors.ink)
        FamilyProgressBar(frac, tint = tint, track = tint.copy(alpha = 0.18f))
    }
}

// ---- the day list (events, then chores) ---------------------------------------

@Composable
private fun DayList(
    events: List<SyncedEvent>,
    chores: List<FamilyApi.ChoreInstance>,
    loading: Boolean,
    zone: ZoneId,
    choreRow: (@Composable (FamilyApi.ChoreInstance, onToggle: () -> Unit) -> Unit)?,
    onOpenEvent: (SyncedEvent) -> Unit,
    onToggle: (FamilyApi.ChoreInstance) -> Unit,
) {
    if (events.isEmpty() && chores.isEmpty()) {
        Text(
            if (loading) "Loading…" else "Nothing scheduled today.",
            modifier = Modifier.padding(vertical = 12.dp),
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink3,
        )
        return
    }
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(vertical = 4.dp),
    ) {
        // Events first (time on the left), then chores (a check on the left), so the two
        // read as different at a glance.
        events.forEachIndexed { i, ev ->
            EventRow(ev, zone, onOpenEvent)
            if (i < events.size - 1 || chores.isNotEmpty()) RowDivider()
        }
        chores.forEachIndexed { i, c ->
            if (choreRow != null) choreRow(c) { onToggle(c) } else FallbackChoreRow(c) { onToggle(c) }
            if (i < chores.size - 1) RowDivider()
        }
    }
}

@Composable
private fun EventRow(ev: SyncedEvent, zone: ZoneId, onOpen: (SyncedEvent) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpen(ev) }
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            PersonSpotlight.eventTime(ev, zone),
            modifier = Modifier.width(60.dp),
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink3,
        )
        Text(
            ev.title,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        Icon(Icons.Filled.CalendarToday, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
    }
}

/** Drawn only when `app` passes no Chores check row; same tap rules either way. */
@Composable
private fun FallbackChoreRow(c: FamilyApi.ChoreInstance, onToggle: () -> Unit) {
    val (icon, tint) = when (c.status) {
        "done" -> Icons.Filled.CheckCircle to FamilyColor.Person3.solid
        "awaiting" -> Icons.Filled.Schedule to WF.colors.gold
        else -> Icons.Filled.RadioButtonUnchecked to WF.colors.ink3
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = c.status, tint = tint, modifier = Modifier.size(22.dp))
        Text(c.emoji ?: "🧹", style = TextStyle(fontSize = 16.sp))
        Text(
            c.choreTitle,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
            color = if (c.status == "done") WF.colors.ink3 else WF.colors.ink,
        )
    }
}

@Composable
private fun RowDivider() {
    Box(Modifier.fillMaxWidth().padding(start = 14.dp).height(1.dp).background(WF.colors.hair2))
}

// ---- whole-person balance + goals ----------------------------------------------

@Composable
private fun BalanceCard(ov: FamilyApi.PersonOverview, slots: PersonSpotlightSlots) {
    SpotlightCard("Whole-person balance") {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ov.categoryBalance.forEach { c ->
                val active = c.goalCount > 0
                Column(Modifier.width(64.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.size(52.dp), contentAlignment = Alignment.Center) {
                        // Material's determinate ring is the native control for a goal ring.
                        CircularProgressIndicator(
                            progress = { (c.avgPct / 100f).coerceIn(0f, 1f) },
                            modifier = Modifier.size(52.dp),
                            color = if (active) slots.goalTint(c.category) else WF.colors.hair,
                            trackColor = WF.colors.hair,
                            strokeWidth = 5.dp,
                            gapSize = 0.dp,
                        )
                        Text(c.emoji, modifier = Modifier.alpha(if (active) 1f else 0.4f), style = TextStyle(fontSize = 18.sp))
                    }
                    Text(c.label, style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                    Text(
                        if (active) "${c.goalCount} goal${if (c.goalCount == 1) "" else "s"}" else "none yet",
                        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
        val insight = ov.insight?.text.orEmpty()
        if (insight.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(WF.colors.ai.copy(alpha = 0.08f), RoundedCornerShape(WF.radius.sm))
                    .padding(11.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.AutoAwesome, contentDescription = null, tint = WF.colors.ai, modifier = Modifier.size(14.dp).padding(top = 1.dp))
                Text(insight, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Medium), color = WF.colors.ai)
            }
        }
    }
}

@Composable
private fun GoalsCard(
    ov: FamilyApi.PersonOverview,
    firstName: String,
    slots: PersonSpotlightSlots,
    onOpen: (HubRoute) -> Unit,
) {
    SpotlightCard("$firstName’s goals") {
        ov.goals.forEach { g ->
            val c = slots.goalTint(g.category)
            Column(
                Modifier.fillMaxWidth().clickable { onOpen(HubRoute.Goal(g.id)) },
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    Text(g.emoji ?: "🎯", style = TextStyle(fontSize = 17.sp))
                    Text(
                        g.title,
                        modifier = Modifier.weight(1f, fill = false),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    g.category?.let { cat ->
                        Text(
                            cat.replaceFirstChar { it.uppercase() },
                            modifier = Modifier
                                .background(c.copy(alpha = 0.14f), RoundedCornerShape(WF.radius.pill))
                                .padding(horizontal = 7.dp, vertical = 2.dp),
                            style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black),
                            color = c,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    Text(
                        "${PersonSpotlight.fmt(g.progress)}/${PersonSpotlight.fmt(g.target)}${g.unit?.let { " $it" }.orEmpty()}",
                        maxLines = 1,
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink2,
                    )
                }
                FamilyProgressBar((g.pct ?: 0) / 100.0, tint = c, track = WF.colors.hair)
            }
        }
    }
}

// ---- currencies + ledger + redemptions -----------------------------------------

@Composable
private fun CurrenciesCard(ov: FamilyApi.PersonOverview, onAward: (() -> Unit)?, onTrade: (() -> Unit)?) {
    SpotlightCard("Currencies & chores") {
        // Balances scroll so the action pills always keep their room.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                PersonSpotlight.balances(ov).forEach { b ->
                    BalanceLine(b, colorFromHex(b.colorHex) ?: WF.colors.gold)
                }
            }
            onAward?.let { ActionPill(Icons.Filled.Star, "Award", WF.colors.gold, 0.16f, it) }
            onTrade?.let { ActionPill(Icons.Filled.SwapHoriz, "Trade", WF.colors.ai, 0.12f, it) }
        }
        if (ov.recentLedger.isNotEmpty()) {
            SectionLabel("Recent")
            val rows = ov.recentLedger.take(6)
            Column {
                rows.forEachIndexed { i, e ->
                    Row(
                        Modifier.padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            "${if (e.amount >= 0) "+" else ""}${e.amount}",
                            modifier = Modifier.width(38.dp),
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black),
                            color = if (e.amount >= 0) FamilyColor.Person3.solid else WF.colors.primary,
                        )
                        Text(PersonSpotlight.symbol(ov, e.currency), style = TextStyle(fontSize = 11.sp))
                        Text(
                            e.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                    }
                    if (i < rows.size - 1) Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
                }
            }
        }
    }
}

@Composable
private fun ActionPill(icon: ImageVector, label: String, tint: Color, alpha: Float, onClick: () -> Unit) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .clip(pill)
            .background(tint.copy(alpha = alpha), pill)
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        Text(label, maxLines = 1, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = tint)
    }
}

@Composable
private fun RedemptionsCard(ov: FamilyApi.PersonOverview) {
    SpotlightCard("Reward redemptions") {
        Column {
            ov.redemptions.forEachIndexed { i, r ->
                val approved = r.status == "approved"
                val tint = if (approved) FamilyColor.Person3.solid else WF.colors.ink3
                Row(
                    Modifier.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    Text(r.emoji ?: "🎁", style = TextStyle(fontSize = 16.sp))
                    Text(
                        r.title,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                    Text(
                        r.status.replaceFirstChar { it.uppercase() },
                        modifier = Modifier
                            .background(tint.copy(alpha = 0.14f), RoundedCornerShape(WF.radius.pill))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black),
                        color = tint,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(PersonSpotlight.symbol(ov, r.currency), style = TextStyle(fontSize = 11.sp))
                        Text("${r.cost}", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                    }
                }
                if (i < ov.redemptions.size - 1) Box(Modifier.fillMaxWidth().height(1.dp).background(WF.colors.hair2))
            }
        }
    }
}

@Composable
private fun AddButton(firstName: String, onAdd: () -> Unit) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .padding(top = 4.dp)
            .fillMaxWidth()
            .clip(pill)
            .background(WF.colors.primary, pill)
            .clickable(onClick = onAdd)
            .padding(vertical = 15.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // White on the saturated primary fill is the allowed literal-white case.
        Icon(Icons.Filled.Add, contentDescription = null, tint = Color.White, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(8.dp))
        Text("Add something for $firstName", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = Color.White)
    }
}
