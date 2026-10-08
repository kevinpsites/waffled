package app.waffled.feature.settingshousehold

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Settings → AI & Capture: which model powers the "Add anything" bar, an optional model
 * override, and the words goal suggestions ignore. Admin-only (the shell gates it).
 */
@Composable
fun AiSettingsPanel(api: SettingsHouseholdApi, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf<SettingsHouseholdApi.CaptureConfig?>(null) }
    var provider by remember { mutableStateOf("heuristic") }
    var model by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var ignores by remember { mutableStateOf<List<SettingsHouseholdApi.IgnoreGroup>>(emptyList()) }

    LaunchedEffect(api) {
        // Its own fetch: the list needs the Goals module, the provider picker doesn't.
        ignores = runCatchingIo { api.goalSuggestionIgnores() } ?: emptyList()
        val c = runCatchingIo { api.captureConfig() }
        if (c != null) {
            config = c; provider = c.provider; model = c.model.orEmpty()
        } else {
            failed = true
        }
        loading = false
    }

    SettingsPage(modifier) {
        val cfg = config
        when {
            cfg != null -> {
                Caption("Powers the “Add anything” bar.", size = 13f)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    AiSettingsLogic.order.forEach { p ->
                        ProviderCard(p, cfg, selected = provider == p) {
                            if (AiSettingsLogic.isEnabled(p, cfg)) {
                                provider = p; saved = false
                                model = AiSettingsLogic.modelOnPick(p, cfg)
                            }
                        }
                    }
                }
                if (provider != "heuristic") {
                    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        SectionLabel("Model")
                        WaffledTextField(
                            value = model,
                            onValueChange = { model = it; saved = false },
                            placeholder = cfg.defaultModels[provider] ?: "default",
                        )
                        Caption("Overrides the server default for this provider.")
                    }
                }
                val dirty = AiSettingsLogic.isDirty(cfg, provider, model)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    WaffledPrimaryCTA(
                        label = if (saving) "Saving…" else "Save",
                        onClick = {
                            scope.launch {
                                saving = true; saved = false
                                val r = runCatchingIo {
                                    api.setCaptureConfig(provider, AiSettingsLogic.modelForSave(provider, model))
                                }
                                if (r != null) {
                                    config = cfg.copy(provider = r.provider, model = r.model)
                                    model = r.model.orEmpty()
                                    saved = true
                                }
                                saving = false
                            }
                        },
                        modifier = Modifier.width(120.dp),
                        isDisabled = !dirty || saving,
                    )
                    if (saved) {
                        Text("✓ Saved", style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold), color = WF.colors.success)
                    }
                }
                Caption("Keys are read from the server environment and never leave it.")
                if (ignores.isNotEmpty()) {
                    IgnoredSection(ignores) { group, word ->
                        scope.launch {
                            if (runCatchingIo { api.removeGoalSuggestionIgnore(group.goalId, word) } != null) {
                                ignores = runCatchingIo { api.goalSuggestionIgnores() } ?: ignores
                            }
                        }
                    }
                }
            }
            failed -> Caption("Couldn’t load AI settings.", Modifier.padding(vertical = 30.dp), size = 14f)
            loading -> WaffledLoading(top = 40.dp)
        }
    }
}

@Composable
private fun ProviderCard(
    p: String,
    cfg: SettingsHouseholdApi.CaptureConfig,
    selected: Boolean,
    onPick: () -> Unit,
) {
    val m = AiSettingsLogic.meta[p] ?: AiSettingsLogic.Meta(p, "", "")
    val enabled = AiSettingsLogic.isEnabled(p, cfg)
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(WF.colors.card)
            .border(1.dp, if (selected) WF.colors.primary.copy(alpha = 0.4f) else WF.colors.hair, shape)
            .clickable(enabled = enabled, onClick = onPick)
            .padding(13.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (selected) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked,
            contentDescription = null,
            tint = if (selected) WF.colors.primary else WF.colors.ink3,
            modifier = Modifier.size(22.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                m.label,
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = if (enabled) WF.colors.ink else WF.colors.ink3,
            )
            Caption(if (enabled) m.sub else "Set ${m.envHint} in the server environment to enable")
        }
        Spacer(Modifier.width(6.dp))
        if (p != "heuristic") {
            WaffledStatusBadge(
                text = if (enabled) "key detected" else "not configured",
                color = if (enabled) WF.colors.success else WF.colors.ink3,
                size = 10.5.sp,
            )
        }
    }
}

/** Words picked from Review events → "Ignore events like this…"; tap one to allow it again. */
@Composable
private fun IgnoredSection(
    groups: List<SettingsHouseholdApi.IgnoreGroup>,
    onRemove: (SettingsHouseholdApi.IgnoreGroup, String) -> Unit,
) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionLabel("Ignored for suggestions")
        Caption("Events with these words are never suggested for the goal. Tap a word to allow it again.")
        groups.forEach { g ->
            HairlineCard(padding = 13.dp) {
                Text(
                    g.goalEmoji?.let { "$it ${g.goalTitle}" } ?: g.goalTitle,
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
                Spacer(Modifier.size(8.dp))
                ChipFlow(spacing = 7.dp) {
                    g.words.forEach { word ->
                        Row(
                            modifier = Modifier
                                .wfChip(selected = false)
                                .clickable { onRemove(g, word) }
                                .semantics { contentDescription = "Stop ignoring $word" }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(word, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink2)
                            Icon(Icons.Filled.Close, contentDescription = null, tint = WF.colors.ink3, modifier = Modifier.size(11.dp))
                        }
                    }
                }
            }
        }
    }
}

/** Run a request, returning null on any failure (cancellation still propagates). */
internal suspend fun <T> runCatchingIo(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
