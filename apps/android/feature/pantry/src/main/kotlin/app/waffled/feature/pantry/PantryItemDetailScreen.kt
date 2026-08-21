package app.waffled.feature.pantry

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.network.MediaImageEncoder
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.put

/**
 * The item detail — the Open Food Facts product card.
 *
 * Photo panel on top (with the source credit and "Replace photo"), then the facts:
 * location, best by, when it came in, the amount with a stepper, the "Contains" allergen
 * badges — red-ringed and named when the household flags one — the "may contain" traces,
 * the dietary chips and the nutrition table.
 *
 * **Scope:** phone only. iOS puts the photo in a left-hand column on iPad; that is a
 * later phase.
 */
@Composable
fun PantryItemDetailScreen(
    row: PantryRow,
    model: PantryModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val config by model.config.collectAsStateWithLifecycle()
    val avoid = model.avoidSet

    var editing by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(false) }
    var uploadError by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        uploading = true
        uploadError = null
        scope.launch {
            val outcome = runCatching {
                // Decoding and JPEG-encoding a phone photo is heavy CPU work; it must not
                // run on the main thread or the whole screen stutters mid-upload.
                val encoded = withContext(Dispatchers.IO) {
                    MediaImageEncoder.encode(context, uri)
                }
                val uploaded = model.api.uploadMedia(encoded.base64, encoded.contentType)
                model.api.update(row.id, PantryApi.patch { put("imageUrl", uploaded.url) })
            }
            outcome
                .onSuccess { model.replace(it) }
                .onFailure { uploadError = it.message ?: "Couldn't replace that photo." }
            uploading = false
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .verticalScroll(rememberScrollState()),
    ) {
        PhotoPanel(
            row = row,
            uploading = uploading,
            onBack = onBack,
            onReplace = {
                picker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
        )

        Column(
            Modifier
                .padding(16.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(row.name, style = WF.type.serif(24.sp, FontWeight.Bold), color = WF.colors.ink)
                subtitle(row)?.let {
                    Text(it, style = WF.type.bodySmall, color = WF.colors.ink3)
                }
            }

            uploadError?.let {
                DismissibleErrorBanner(it, onDismiss = { uploadError = null })
            }

            FactsCard(row, model, scope)

            row.item.allergens?.takeIf { it.isNotEmpty() }?.let { allergens ->
                ContainsBlock(allergens, avoid, row.affects)
            }

            row.item.traces?.takeIf { it.isNotEmpty() }?.let { traces ->
                Text(
                    "May contain " + traces.joinToString(", ") { PantryAllergen.label(it) },
                    style = TextStyle(fontSize = 12.5.sp),
                    color = WF.colors.ink3,
                )
            }

            DietaryChips(row.item.dietary)

            row.item.nutrition?.takeIf { !it.isEmpty }?.let { NutritionCard(row, it) }

            row.item.sourceLabel?.let { label ->
                // Food resolves nutrition and allergens; the non-food siblings only carry
                // a name, brand and photo, so word the credit accordingly.
                val hasFoodDetail = row.item.nutrition?.isEmpty == false ||
                    !row.item.allergens.isNullOrEmpty()
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(8.dp).background(WF.colors.success, CircleShape))
                    Text(
                        (if (hasFoodDetail) "Nutrition & allergens" else "Product info") +
                            " from $label",
                        style = WF.type.caption,
                        color = WF.colors.ink3,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaffledSecondaryCTA(
                    label = if (row.usedUp) "Back on hand" else "Mark used up",
                    onClick = { scope.launch { model.setUsedUp(row, !row.usedUp) } },
                    modifier = Modifier.weight(1f),
                )
                WaffledPrimaryCTA(
                    label = "Edit",
                    onClick = { editing = true },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }

    if (editing) {
        PantryItemEditorSheet(
            mode = PantryEditorMode.Edit(row),
            locations = config.locations,
            api = model.api,
            onDismiss = { editing = false },
            onLocationsChanged = { model.load() },
            onSave = { body -> model.update(row.id, body) },
            onDelete = {
                // Removing the item empties it out of the model, and the list screen's
                // "the open row is gone" branch pops back automatically.
                model.delete(row)
                onBack()
            },
        )
    }
}

private fun subtitle(row: PantryRow): String? =
    listOfNotNull(row.item.brand, row.item.quantityText)
        .filter { it.isNotBlank() }
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" · ")

// ---------------------------------------------------------------------------
// Photo panel
// ---------------------------------------------------------------------------

@Composable
private fun PhotoPanel(
    row: PantryRow,
    uploading: Boolean,
    onBack: () -> Unit,
    onReplace: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(260.dp)
            .background(WF.colors.panel),
        contentAlignment = Alignment.Center,
    ) {
        if (row.imageUrl != null) {
            val context = LocalContext.current
            AsyncImage(
                model = WaffledImages.request(context, row.imageUrl, row.imageCacheKey),
                contentDescription = row.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().padding(28.dp),
            )
        } else {
            Text(row.emoji, style = TextStyle(fontSize = 72.sp))
        }

        Column(Modifier.fillMaxSize().statusBarsPadding().padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(36.dp)
                        .background(WF.colors.card, CircleShape)
                        .clip(CircleShape)
                        .clickable(onClick = onBack),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = WF.colors.ink,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Spacer(Modifier.width(10.dp))
                row.item.sourceLabel?.let { SourceBadge(it) }
            }
            Spacer(Modifier.weight(1f))
            Row(
                Modifier
                    .background(WF.colors.ink, RoundedCornerShape(WF.radius.pill))
                    .clip(RoundedCornerShape(WF.radius.pill))
                    .clickable(enabled = !uploading, onClick = onReplace)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.CameraAlt,
                    contentDescription = null,
                    // `onInk` on a solid `ink` fill — never literal white, which vanishes
                    // when `ink` flips to warm off-white in dark.
                    tint = WF.colors.onInk,
                    modifier = Modifier.size(14.dp),
                )
                Text(
                    if (uploading) "Uploading…" else "Replace photo",
                    style = WF.type.label,
                    color = WF.colors.onInk,
                )
            }
        }
    }
}

@Composable
private fun SourceBadge(label: String) {
    Row(
        Modifier
            .background(WF.colors.card, RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(WF.colors.success, CircleShape))
        Text(
            label.uppercase(),
            style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Black, letterSpacing = 0.4.sp),
            color = WF.colors.ink2,
        )
    }
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

@Composable
private fun FactsCard(
    row: PantryRow,
    model: PantryModel,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape),
    ) {
        FactRow("Location") {
            Text(
                row.item.location.ifBlank { "—" },
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
        }
        HorizontalDivider(color = WF.colors.hair)
        FactRow("Best by") {
            Text(
                row.expiryLabelLong ?: "—",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = if (row.expiryLabelLong == null) WF.colors.ink3 else row.expiryTone.color(),
            )
        }
        HorizontalDivider(color = WF.colors.hair)
        FactRow("Added") {
            if (row.ageLabel != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        row.addedShort ?: "—",
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    AgePill(row.ageLabel, icon = false, trailing = " ago", fontSize = 12.5.sp)
                }
            } else {
                Text(
                    "—",
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink3,
                )
            }
        }
        HorizontalDivider(color = WF.colors.hair)
        FactRow("Amount") {
            if (row.usedUp) {
                Text(
                    "Used up",
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink3,
                )
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    StepperGlyph(Icons.Filled.Remove, "One fewer", {
                        scope.launch { model.adjust(row, -1.0) }
                    }, size = 30.dp)
                    Text(
                        row.amountLabel ?: "—",
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    StepperGlyph(Icons.Filled.Add, "One more", {
                        scope.launch { model.adjust(row, 1.0) }
                    }, size = 30.dp)
                }
            }
        }
    }
}

@Composable
private fun FactRow(label: String, trailing: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = WF.type.body, color = WF.colors.ink3)
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

// ---------------------------------------------------------------------------
// Allergens + nutrition
// ---------------------------------------------------------------------------

@Composable
private fun ContainsBlock(allergens: List<String>, avoid: Set<String>, affects: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("Contains")
        PantryChipFlow(spacing = 10.dp) {
            allergens.forEach { key ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AllergenBadge(key, avoid = key in avoid)
                    Text(PantryAllergen.label(key), style = WF.type.label, color = WF.colors.ink)
                }
            }
        }
        if (affects.isNotEmpty()) {
            // "Contains milk" only helps if you remember who reacts to it — so say so.
            Text(
                "⚠ Affects " + affects.joinToString(", "),
                style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.danger,
            )
        }
    }
}

@Composable
private fun NutritionCard(row: PantryRow, nutrition: PantryApi.Nutrition) {
    val rows = buildList {
        nutrition.calories?.let { add("Calories" to PantryAmount.format(it)) }
        nutrition.proteinG?.let { add("Protein" to "${PantryAmount.format(it)} g") }
        nutrition.fatG?.let { add("Total fat" to "${PantryAmount.format(it)} g") }
        nutrition.carbsG?.let { add("Carbohydrate" to "${PantryAmount.format(it)} g") }
        nutrition.sodiumMg?.let { add("Sodium" to "${PantryAmount.format(it)} mg") }
    }
    val shape = RoundedCornerShape(WF.radius.md)
    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Nutrition", style = WF.type.sectionTitle, color = WF.colors.ink)
            Spacer(Modifier.weight(1f))
            row.item.servingBasis?.let {
                Text(it, style = WF.type.caption, color = WF.colors.ink3)
            }
        }
        // The heavy rule under the heading, matching the printed nutrition panel the web
        // and iOS both imitate.
        Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .height(3.dp)
                .background(WF.colors.ink),
        )
        rows.forEachIndexed { index, (label, value) ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, style = WF.type.body, color = WF.colors.ink)
                Spacer(Modifier.weight(1f))
                Text(
                    value,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
            }
            if (index != rows.lastIndex) HorizontalDivider(color = WF.colors.hair)
        }
    }
}
