package app.waffled.feature.pantry

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.core.network.MediaUrl
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate

/**
 * The confirm-and-add sheet shown once a barcode resolves.
 *
 * A found product prefills its name, brand and photo, and carries the whole Open Food
 * Facts snapshot onto the item so the detail can show nutrition later; an unknown barcode
 * just asks for a name. "Add & scan next" commits and re-arms the flow.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryFoundSheet(
    result: ScanResult,
    locations: List<String>,
    avoid: Set<String>,
    allergenPeople: Map<String, List<String>>,
    api: PantryApi,
    onDismiss: () -> Unit,
    onAdd: suspend (JsonObject, String) -> Unit,
    today: LocalDate = LocalDate.now(),
    onLocationsChanged: suspend () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val product = result.product

    var name by remember { mutableStateOf(product?.name.orEmpty()) }
    var location by remember { mutableStateOf(locations.firstOrNull() ?: "Pantry") }
    var amount by remember { mutableStateOf("1") }
    var unit by remember { mutableStateOf("") }
    var expiry by remember { mutableStateOf<LocalDate?>(null) }
    var pickingExpiry by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            StatusBadge(result)

            // Hero: photo + editable name.
            Row(
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Hero(product, name)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    WaffledTextField(
                        value = name,
                        onValueChange = { name = it },
                        placeholder = "Item name",
                    )
                    subtitle(product)?.let {
                        Text(it, style = WF.type.bodySmall, color = WF.colors.ink3, maxLines = 1)
                    }
                }
            }

            AllergenBlock(product, avoid, allergenPeople)

            HorizontalDivider(color = WF.colors.hair)

            PantryLocationPicker(
                selection = location,
                onSelect = { location = it },
                locations = locations,
                api = api,
                onLocationsChanged = onLocationsChanged,
            )

            AmountRow(
                amount = amount,
                onAmount = { amount = it },
                unit = unit,
                onUnit = { unit = it },
            )

            // Best by, as a switch + a tappable date — same shape as the editor.
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("Best by", Modifier.weight(1f))
                    Switch(
                        checked = expiry != null,
                        onCheckedChange = { on -> expiry = if (on) (expiry ?: today) else null },
                        colors = SwitchDefaults.colors(checkedTrackColor = WF.colors.primary),
                    )
                }
                expiry?.let { date ->
                    Text(
                        PantryExpiry.shortLabelFull(date),
                        Modifier
                            .fillMaxWidth()
                            .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
                            .clip(RoundedCornerShape(WF.radius.md))
                            .clickable { pickingExpiry = true }
                            .padding(horizontal = 14.dp, vertical = 13.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink,
                    )
                }
            }

            WaffledPrimaryCTA(
                label = "Add & scan next",
                onClick = {
                    saving = true
                    scope.launch {
                        onAdd(
                            PantryApi.scanBody(
                                name = name.trim(),
                                amount = PantryAmount.canonical(amount),
                                unit = unit.trim(),
                                location = location,
                                expiresOn = expiry?.let(PantryExpiry::string),
                                product = product,
                                barcode = result.barcode,
                            ),
                            PantryFood.emoji(name),
                        )
                        saving = false
                    }
                },
                isBusy = saving,
                isDisabled = name.isBlank(),
            )
        }
    }

    if (pickingExpiry) {
        PantryDatePickerDialog(
            initial = expiry ?: today,
            onDismiss = { pickingExpiry = false },
            onPick = {
                expiry = it
                pickingExpiry = false
            },
        )
    }
}

private fun subtitle(product: PantryApi.Product?): String? =
    listOfNotNull(product?.brand, product?.quantityText)
        .filter { it.isNotBlank() }
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" · ")

@Composable
private fun StatusBadge(result: ScanResult) {
    val product = result.product
    // Credit whichever database answered (Open Food / Beauty / Products / Pet Food
    // Facts); an unrecognised barcode still adds cleanly by name.
    val text = when {
        product == null -> "Not found in a product database · ${result.barcode}"
        product.sourceLabel != null -> "Found · ${product.sourceLabel}"
        else -> "Found · ${result.barcode}"
    }
    val tint = if (product != null) WF.colors.success else WF.colors.ink3
    Row(
        Modifier
            .background(tint.copy(alpha = 0.12f), RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 11.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (product != null) Icons.Filled.CheckCircle else Icons.AutoMirrored.Filled.HelpOutline,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(14.dp),
        )
        Text(
            text,
            style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
            color = tint,
        )
    }
}

@Composable
private fun Hero(product: PantryApi.Product?, name: String) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        Modifier
            .size(64.dp)
            .background(WF.colors.panel, shape)
            .clip(shape),
        contentAlignment = Alignment.Center,
    ) {
        val url = product?.imageUrl
        if (url != null) {
            val context = LocalContext.current
            AsyncImage(
                // The product photo is already an absolute Open Food Facts URL, but it is
                // still cached on its stable path — see MediaUrl.cacheKey.
                model = WaffledImages.request(context, url, MediaUrl.cacheKey(url)),
                contentDescription = name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                PantryFood.emoji(name.ifBlank { "x" }),
                style = TextStyle(fontSize = 30.sp),
            )
        }
    }
}

/**
 * What the product database says is in it.
 *
 * Anything the household avoids is ringed red **and called out by name and person** —
 * "contains milk" only helps if you remember who reacts to it, and at the scanner you are
 * deciding in about two seconds.
 */
@Composable
private fun AllergenBlock(
    product: PantryApi.Product?,
    avoid: Set<String>,
    allergenPeople: Map<String, List<String>>,
) {
    val allergens = product?.allergens.orEmpty()
    val traces = product?.traces.orEmpty().filterNot { it in allergens }
    if (allergens.isEmpty() && traces.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (allergens.isNotEmpty()) ContainsRow(allergens, "Contains", avoid, trace = false)
        if (traces.isNotEmpty()) ContainsRow(traces, "May contain", avoid, trace = true)

        val flagged = PantryAllergen.flagged(allergens, avoid)
        if (flagged.isNotEmpty()) {
            val what = flagged.joinToString(", ") { PantryAllergen.label(it) }
            val who = PantryAllergen.affected(flagged, allergenPeople)
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(WF.colors.dangerT, RoundedCornerShape(WF.radius.sm))
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    Icons.Filled.Warning,
                    contentDescription = null,
                    tint = WF.colors.danger,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    text = if (who.isEmpty()) {
                        "Contains $what — your household avoids it."
                    } else {
                        "Contains $what — affects ${who.joinToString(", ")}."
                    },
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.danger,
                )
            }
        }
    }
}

@Composable
private fun ContainsRow(
    allergens: List<String>,
    label: String,
    avoid: Set<String>,
    trace: Boolean,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            label,
            Modifier.padding(top = 3.dp),
            style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink3,
        )
        PantryChipFlow(spacing = 6.dp) {
            allergens.forEach { key ->
                Row(
                    Modifier
                        .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AllergenBadge(key, avoid = key in avoid, trace = trace)
                    Text(
                        PantryAllergen.label(key),
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
            }
        }
    }
}

/**
 * Amount: typeable, not just steppable.
 *
 * Half a bag of flour and a quarter block of cheese are normal things to put away, and ±1
 * expresses neither. The fraction chips are for the scan loop, where reaching for the
 * keyboard is the slow part.
 */
@Composable
private fun AmountRow(
    amount: String,
    onAmount: (String) -> Unit,
    unit: String,
    onUnit: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        SectionLabel("Amount")
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StepperGlyph(
                Icons.Filled.Remove,
                "One fewer",
                { onAmount(PantryAmount.stepped(amount, -1.0)) },
                size = 30.dp,
                tint = WF.colors.ink,
            )
            WaffledTextField(
                value = amount,
                onValueChange = onAmount,
                modifier = Modifier.width(76.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            StepperGlyph(
                Icons.Filled.Add,
                "One more",
                { onAmount(PantryAmount.stepped(amount, 1.0)) },
                size = 30.dp,
                tint = WF.colors.ink,
            )
            WaffledTextField(
                value = unit,
                onValueChange = onUnit,
                modifier = Modifier.weight(1f),
                placeholder = "unit",
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FRACTIONS.forEach { (label, value) ->
                val on = PantryAmount.value(amount) == value
                Text(
                    label,
                    Modifier
                        .wfChip(selected = on)
                        .clickable { onAmount(PantryAmount.format(value)) }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = if (on) WF.colors.ink else WF.colors.ink2,
                )
            }
        }
    }
}

/** Part-of-a-package shortcuts — the fractions people actually reach for. */
private val FRACTIONS = listOf("¼" to 0.25, "½" to 0.5, "¾" to 0.75)
