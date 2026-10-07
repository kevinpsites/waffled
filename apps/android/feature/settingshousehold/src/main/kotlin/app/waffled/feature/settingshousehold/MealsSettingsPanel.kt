package app.waffled.feature.settingshousehold

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSettingsMenuLabel
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.launch

/**
 * Settings → Meals: how planned meals land on the calendar — the add/push toggles, the
 * owning person, who's invited, per-meal times and the thaw reminder. Saving re-syncs
 * existing planned meals, so [bus] (when given) is bumped for Meals afterwards.
 */
@Composable
fun MealsSettingsPanel(api: SettingsHouseholdApi, modifier: Modifier = Modifier, bus: RefreshBus? = null) {
    val scope = rememberCoroutineScope()
    var members by remember { mutableStateOf<List<Person>>(emptyList()) }
    var s by remember { mutableStateOf<SettingsHouseholdApi.MealCalendarSettings?>(null) }
    var failed by remember { mutableStateOf(false) }
    var dirty by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }

    LaunchedEffect(api) {
        members = runCatchingIo { api.householdMembers() } ?: emptyList()
        val loaded = runCatchingIo { api.mealCalendarSettings() }
        if (loaded != null) s = loaded else failed = true
    }

    fun edit(change: (SettingsHouseholdApi.MealCalendarSettings) -> SettingsHouseholdApi.MealCalendarSettings) {
        s = s?.let(change); dirty = true; saved = false
    }

    SettingsPage(modifier) {
        val cur = s
        when {
            cur != null -> {
                val allIds = members.map { it.id }
                val on = cur.addToCalendar
                WaffledCard(padding = 4.dp) {
                    SettingRow("📅", "Add planned meals to the calendar", "Each meal you plan shows on the Waffled calendar, linked to its recipe.") {
                        WFSwitch(cur.addToCalendar, { v -> edit { it.copy(addToCalendar = v) } })
                    }
                    HairDivider()
                    SettingRow("🔄", "Sync them to Google Calendar", "Also push meal events so they show on everyone’s phones.") {
                        WFSwitch(on && cur.pushToGoogle, { v -> edit { it.copy(pushToGoogle = v) } }, enabled = on)
                    }
                    HairDivider()
                    SettingRow("👤", "Add to this person’s calendar", "Uses their color + Google write-target.") {
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            WaffledSettingsMenuLabel(
                                members.firstOrNull { it.id == cur.calendarPersonId }?.name ?: "Unassigned",
                                Modifier.clickable(enabled = on) { menu = true }.alpha(if (on) 1f else 0.45f),
                            )
                            OptionsMenu(
                                menu, { menu = false },
                                listOf("Unassigned" to { edit { it.copy(calendarPersonId = null) } }) +
                                    members.map { m -> m.name to { edit { it.copy(calendarPersonId = m.id) } } },
                            )
                        }
                    }
                }

                WaffledCard(padding = 14.dp) {
                    Text("Who’s invited", style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    Caption(if (cur.participantIds == null) "The whole family" else "${cur.participantIds.size} selected")
                    Gap(11.dp)
                    ChipFlow(Modifier.alpha(if (on) 1f else 0.4f)) {
                        SolidChip("Whole family", cur.participantIds == null, enabled = on) {
                            edit { it.copy(participantIds = null) }
                        }
                        members.forEach { m ->
                            SolidChip("${m.avatarEmoji ?: "🙂"} ${m.name}", m.id in (cur.participantIds ?: allIds), enabled = on) {
                                edit { it.copy(participantIds = MealsSettingsLogic.toggleParticipant(it.participantIds, m.id, allIds)) }
                            }
                        }
                    }
                }

                WaffledCard(padding = 4.dp) {
                    Column(Modifier.padding(start = 11.dp, end = 11.dp, top = 11.dp, bottom = 6.dp)) {
                        Text("Meal times", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                        Caption("When each meal lands on the calendar.")
                    }
                    MealsSettingsLogic.mealRows.forEachIndexed { i, m ->
                        if (i > 0) HairDivider()
                        Row(
                            Modifier.fillMaxWidth().padding(11.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(m.icon, style = TextStyle(fontSize = 17.sp))
                            Text(m.label, Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                            TimeField(cur.times[m.key] ?: "12:00", { t -> edit { it.copy(times = it.times + (m.key to t)) } }, enabled = on)
                        }
                    }
                }

                WaffledCard(padding = 4.dp) {
                    SettingRow(
                        "🧊", "Thaw reminder",
                        "Adds a same-day calendar reminder to pull the protein/ingredients out of the freezer for that day’s planned meal.",
                    ) { WFSwitch(cur.prepReminder, { v -> edit { it.copy(prepReminder = v) } }) }
                    HairDivider()
                    SettingRow("⏰", "Remind me at", "Time it lands, on the meal’s own day.") {
                        TimeField(cur.prepReminderTime, { t -> edit { it.copy(prepReminderTime = t) } }, enabled = cur.prepReminder)
                    }
                    HairDivider()
                    Column(Modifier.fillMaxWidth().padding(11.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("For which meals", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                        ChipFlow(Modifier.alpha(if (cur.prepReminder) 1f else 0.4f)) {
                            MealsSettingsLogic.mealRows.forEach { m ->
                                SolidChip("${m.icon} ${m.label}", m.key in cur.prepReminderMealTypes, enabled = cur.prepReminder) {
                                    edit { it.copy(prepReminderMealTypes = MealsSettingsLogic.toggle(it.prepReminderMealTypes, m.key)) }
                                }
                            }
                        }
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    WaffledPrimaryCTA(
                        label = if (saving) "Saving…" else "Save",
                        onClick = {
                            scope.launch {
                                saving = true; saved = false
                                val r = runCatchingIo { api.setMealCalendarSettings(MealsSettingsLogic.body(cur)) }
                                if (r != null) {
                                    s = r; dirty = false; saved = true
                                    bus?.bump(RefreshDomain.Meals)
                                }
                                saving = false
                            }
                        },
                        modifier = Modifier.width(120.dp),
                        isDisabled = !dirty || saving,
                    )
                    if (saved) {
                        Text(
                            "✓ Saved · existing meals updated",
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                            color = WF.colors.success,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                }
            }
            failed -> Caption("Couldn’t load meal settings.", Modifier.padding(vertical = 30.dp), size = 14f)
            else -> WaffledLoading(top = 40.dp)
        }
    }
}
