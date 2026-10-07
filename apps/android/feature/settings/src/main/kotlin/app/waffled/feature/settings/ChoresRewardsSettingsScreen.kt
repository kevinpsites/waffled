package app.waffled.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledSettingsMenuLabel
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.colorFromHex
import kotlinx.coroutines.launch

/**
 * Settings → Chores & Rewards: the currency economy (currencies + trade rates), the
 * reward-approval default, and (admins) chore photo-proof retention with the stored
 * photos manager. Each group sits in its own boxed tray.
 */
@Composable
internal fun ChoresRewardsSettingsScreen(
    api: SettingsApi,
    isAdmin: Boolean,
    baseUrl: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var currencies by remember { mutableStateOf<List<SettingsApi.Currency>>(emptyList()) }
    var conversions by remember { mutableStateOf<List<SettingsApi.Conversion>>(emptyList()) }
    var requireApproval by remember { mutableStateOf<Boolean?>(null) }
    var savingApproval by remember { mutableStateOf(false) }
    var proofTtlDays by remember { mutableStateOf<Int?>(null) }
    var savingTtl by remember { mutableStateOf(false) }
    var storedProofs by remember { mutableStateOf<List<SettingsApi.StoredProof>>(emptyList()) }
    var showStoredProofs by remember { mutableStateOf(false) }
    var editor by remember { mutableStateOf<CurrencyEditorTarget?>(null) }
    var fromKey by remember { mutableStateOf("") }
    var toKey by remember { mutableStateOf("") }
    var fromAmt by remember { mutableStateOf("10") }
    var toAmt by remember { mutableStateOf("1") }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload, isAdmin) {
        runCatching { api.currencies() }.getOrNull()?.let { currencies = it }
        runCatching { api.conversions() }.getOrNull()?.let { conversions = it }
        requireApproval = runCatching { api.rewardApprovalRequired() }.getOrDefault(true)
        if (isAdmin) {
            proofTtlDays = runCatching { api.proofTtlDays() }.getOrDefault(3)
            storedProofs = runCatching { api.storedProofs() }.getOrDefault(emptyList())
        }
        val (f, t) = CurrencyRules.seedPickers(currencies, fromKey, toKey)
        fromKey = f
        toKey = t
    }

    SettingsPage("Chores & Rewards", onBack, modifier) {
        GroupTray {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("Currencies & trades")
                Text(
                    boldParts("Rename stars, add your own, or run several. The ", "default", " is what new chores award; ", "spendable", " ones can buy rewards."),
                    style = TextStyle(fontSize = 13.sp),
                    color = WF.colors.ink2,
                )
                currencies.forEach { c -> CurrencyRow(c) { editor = CurrencyEditorTarget(c) } }
                DashedAddButton("Add a currency") { editor = CurrencyEditorTarget(null) }
            }
            if (currencies.size > 1) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Conversions", style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
                    BodyNote("Let the family trade up a tier — e.g. 10 ⭐ → 1 🥢. Anyone can convert their own balance on the Rewards tab.")
                    conversions.forEach { c ->
                        ConversionRow(c) {
                            scope.launch {
                                runCatching { api.deleteConversion(c.id) }
                                reload++
                            }
                        }
                    }
                    AddConversionForm(
                        currencies = currencies,
                        fromKey = fromKey, toKey = toKey, fromAmt = fromAmt, toAmt = toAmt,
                        onFrom = { fromKey = it }, onTo = { toKey = it },
                        onFromAmt = { fromAmt = it }, onToAmt = { toAmt = it },
                    ) {
                        scope.launch {
                            val ok = runCatching {
                                api.createConversion(fromKey, toKey, fromAmt.toIntOrNull() ?: 1, toAmt.toIntOrNull() ?: 1)
                            }.isSuccess
                            if (ok) { fromAmt = "10"; toAmt = "1"; reload++ }
                        }
                    }
                }
            }
        }

        GroupTray {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SectionLabel("Reward approvals")
                Text(
                    boldParts(
                        "Sets the default for ", "new",
                        " rewards. On = a parent OKs the purchase; off = the kid redeems instantly with what they’ve earned. Even if off, each reward can have an override to explicitly require approval.",
                    ),
                    style = TextStyle(fontSize = 13.sp),
                    color = WF.colors.ink2,
                )
                PolicyRow("✅", "New rewards need a parent’s OK by default") {
                    SettingsSwitch(requireApproval ?: true, { on ->
                        val prev = requireApproval
                        requireApproval = on
                        savingApproval = true
                        scope.launch {
                            if (runCatching { api.setRewardApproval(on) }.isFailure) requireApproval = prev
                            savingApproval = false
                        }
                    }, enabled = requireApproval != null && !savingApproval)
                }
            }
        }

        // Retention is an admin write, so only admins see it — no dead end for anyone else.
        if (isAdmin) {
            GroupTray {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionLabel("Chore photo proof")
                    BodyNote("When a chore needs a photo, the snapshot is kept this long after it’s done, then deleted automatically. Awaiting check-offs are always kept until you review them.")
                    PolicyRow("📸", "Keep proof photos for") {
                        TtlMenu(ProofRetention.label(proofTtlDays), enabled = proofTtlDays != null && !savingTtl) { days ->
                            val prev = proofTtlDays
                            proofTtlDays = days
                            savingTtl = true
                            scope.launch {
                                proofTtlDays = runCatching { api.setProofTtlDays(days) }.getOrElse { prev }
                                savingTtl = false
                            }
                        }
                    }
                    if (storedProofs.isNotEmpty()) {
                        Row(
                            Modifier.fillMaxWidth().settingsBox(fill = WF.colors.card2).clickable { showStoredProofs = true }.padding(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.PhotoLibrary, null, tint = WF.colors.ink2, modifier = Modifier.size(16.dp))
                            Text(
                                "View stored photos (${storedProofs.size})",
                                modifier = Modifier.weight(1f),
                                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink2,
                            )
                            Icon(Icons.Filled.ChevronRight, null, tint = WF.colors.ink3, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
    }

    editor?.let { target ->
        CurrencyEditorSheet(
            api = api,
            editing = target.currency,
            canDelete = currencies.size > 1,
            onDone = { reload++ },
            onDismiss = { editor = null },
        )
    }
    if (showStoredProofs) {
        StoredProofsSheet(
            api = api,
            proofs = storedProofs,
            baseUrl = baseUrl,
            onChanged = { storedProofs = runCatching { api.storedProofs() }.getOrDefault(storedProofs) },
            onDismiss = { showStoredProofs = false },
        )
    }
}

private class CurrencyEditorTarget(val currency: SettingsApi.Currency?)

private fun boldParts(vararg parts: String) = buildAnnotatedString {
    parts.forEachIndexed { i, p ->
        if (i % 2 == 1) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(p) } else append(p)
    }
}

/** A warm boxed tray binding one group together and apart from the next. */
@Composable
private fun GroupTray(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(WF.colors.panel, shape)
            .border(1.dp, WF.colors.hair, shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
        content = content,
    )
}

@Composable
private fun PolicyRow(emoji: String, title: String, control: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().settingsBox().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsIcon(emoji)
        Text(title, modifier = Modifier.weight(1f), style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        control()
    }
}

@Composable
private fun TtlMenu(label: String, enabled: Boolean, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        WaffledSettingsMenuLabel(
            label,
            Modifier
                .clip(RoundedCornerShape(WF.radius.sm))
                .background(WF.colors.panel)
                .clickable(enabled = enabled) { open = true }
                .padding(horizontal = 12.dp, vertical = 9.dp),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            ProofRetention.options.forEach { (days, text) ->
                DropdownMenuItem(text = { Text(text, color = WF.colors.ink) }, onClick = { open = false; onPick(days) })
            }
        }
    }
}

@Composable
private fun CurrencyRow(c: SettingsApi.Currency, onEdit: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().settingsBox().clickable(onClick = onEdit).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        app.waffled.core.design.WaffledEmojiTile(
            c.symbol, size = 20.dp, frame = 40.dp, cornerRadius = 11.dp,
            background = (colorFromHex(c.color) ?: WF.colors.gold).copy(alpha = 0.16f),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(c.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (c.isDefault) WaffledStatusBadge("★ Default", WF.colors.gold)
                WaffledStatusBadge(if (c.spendable) "Spendable" else "Earn-only", if (c.spendable) WF.colors.primary else WF.colors.ink3)
            }
        }
        Icon(Icons.Filled.Edit, contentDescription = "Edit", tint = WF.colors.ink3, modifier = Modifier.size(15.dp))
    }
}

@Composable
private fun ConversionRow(c: SettingsApi.Conversion, onDelete: () -> Unit) {
    val side = { amt: Int, s: SettingsApi.Conversion.Side, key: String -> "$amt ${s.symbol ?: "•"} ${s.label ?: key}" }
    Row(
        Modifier.fillMaxWidth().settingsBox().padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(side(c.fromAmount, c.from, c.fromCurrency), style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
        Text(
            side(c.toAmount, c.to, c.toCurrency),
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = WF.colors.ink,
        )
        Box(Modifier.size(28.dp).clickable(onClick = onDelete), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Close, contentDescription = "Delete rate", tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun AddConversionForm(
    currencies: List<SettingsApi.Currency>,
    fromKey: String,
    toKey: String,
    fromAmt: String,
    toAmt: String,
    onFrom: (String) -> Unit,
    onTo: (String) -> Unit,
    onFromAmt: (String) -> Unit,
    onToAmt: (String) -> Unit,
    onAdd: () -> Unit,
) {
    val blocked = fromKey == toKey || fromKey.isEmpty()
    Column(
        Modifier.fillMaxWidth().padding(top = 2.dp).settingsBox(fill = WF.colors.card2).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            AmountField(fromAmt, onFromAmt)
            CurrencyMenu(currencies, fromKey, onFrom)
            Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
            AmountField(toAmt, onToAmt)
            CurrencyMenu(currencies, toKey, onTo)
        }
        Text(
            "＋ Add rate",
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(WF.radius.md))
                .background(if (blocked) WF.colors.ink3 else WF.colors.primary)
                .clickable(enabled = !blocked, onClick = onAdd)
                .padding(vertical = 11.dp),
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
            color = Color.White,
        )
    }
}

@Composable
private fun AmountField(value: String, onChange: (String) -> Unit) {
    BasicTextField(
        value = value,
        onValueChange = { onChange(it.filter(Char::isDigit).take(4)) },
        singleLine = true,
        textStyle = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, color = WF.colors.ink),
        cursorBrush = SolidColor(WF.colors.primary),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier
            .width(44.dp)
            .clip(RoundedCornerShape(WF.radius.sm))
            .background(WF.colors.panel)
            .padding(vertical = 8.dp),
    )
}

@Composable
private fun CurrencyMenu(currencies: List<SettingsApi.Currency>, selected: String, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .clip(RoundedCornerShape(WF.radius.sm))
                .background(WF.colors.panel)
                .clickable { open = true }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(currencies.firstOrNull { it.key == selected }?.symbol ?: "•", style = TextStyle(fontSize = 15.sp))
            Icon(Icons.Filled.KeyboardArrowDown, null, tint = WF.colors.ink3, modifier = Modifier.size(14.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = WF.colors.card) {
            currencies.forEach { c ->
                DropdownMenuItem(text = { Text("${c.symbol} ${c.label}", color = WF.colors.ink) }, onClick = { open = false; onPick(c.key) })
            }
        }
    }
}
