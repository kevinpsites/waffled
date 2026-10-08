package app.waffled.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import kotlinx.coroutines.launch

/**
 * Settings → Modules: turn optional feature areas on/off for the household. Rewards is
 * a sub-toggle under Chores. Non-admins see the state read-only (the server gates writes).
 */
@Composable
internal fun ModulesSettingsScreen(
    api: SettingsApi,
    isAdmin: Boolean,
    onModulesChanged: (Map<String, Boolean>) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val model = remember {
        ModulesModel(
            fetch = { api.household().modules() },
            setModules = api::setModules,
            setRewards = api::setChoresRewards,
            onChanged = onModulesChanged,
        )
    }
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    LaunchedEffect(model) { model.load() }

    SettingsPage("Modules", onBack, modifier, spacing = 14.dp) {
        BodyNote("Turn off whatever your family doesn’t use — its tab, Today card, and pages disappear everywhere. Today and Calendar always stay on.")
        if (!isAdmin) {
            Text(
                "Only an admin can change modules.",
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        if (state.loading) {
            WaffledLoading(top = 30.dp)
        } else {
            ModuleCatalog.available.forEach { m ->
                val on = ModuleCatalog.isOn(m.key, state.flags)
                Column(Modifier.fillMaxWidth().settingsBox()) {
                    ModuleToggleRow(
                        icon = m.icon, title = m.name, subtitle = m.summary, isOn = on,
                        enabled = isAdmin && m.key !in state.saving,
                    ) { scope.launch { model.setModule(m.key, it) } }
                    if (m.key == "chores" && on) {
                        HairDivider(Modifier.padding(start = 52.dp))
                        ModuleToggleRow(
                            icon = "⭐", title = "Rewards",
                            subtitle = "Star shop & redemptions — the spend half of chores.",
                            isOn = state.rewards ?: true,
                            enabled = isAdmin && "rewards" !in state.saving,
                            indented = true,
                        ) { scope.launch { model.setRewards(it) } }
                    }
                }
            }
            if (ModuleCatalog.planned.isNotEmpty()) {
                SectionLabel("Coming soon", Modifier.padding(top = 6.dp))
                ModuleCatalog.planned.forEach { m ->
                    Row(
                        Modifier.fillMaxWidth().alpha(0.7f).settingsBox().padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        SettingsIcon(m.icon)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(m.name, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                            Text(m.summary, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
                        }
                        SoonPill()
                    }
                }
            }
        }
    }
}

@Composable
private fun ModuleToggleRow(
    icon: String,
    title: String,
    subtitle: String,
    isOn: Boolean,
    enabled: Boolean,
    indented: Boolean = false,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(12.dp).padding(start = if (indented) 8.dp else 0.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsIcon(icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Text(subtitle, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
        SettingsSwitch(isOn, onChange, enabled)
    }
}
