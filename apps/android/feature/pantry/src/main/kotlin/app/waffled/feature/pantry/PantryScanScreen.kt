package app.waffled.feature.pantry

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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import kotlinx.coroutines.launch

/**
 * A resolved (or unresolved) barcode, driving the confirm sheet.
 *
 * "Not found" is a real answer — no product database recognises the barcode — and it
 * still adds cleanly by name. It is NOT the same as a failed lookup, which throws.
 */
sealed interface ScanResult {
    val barcode: String

    /** The resolved product, or null when no database recognised the barcode. */
    val product: PantryApi.Product?

    data class Found(
        override val product: PantryApi.Product,
        override val barcode: String,
    ) : ScanResult

    data class NotFound(override val barcode: String) : ScanResult {
        override val product: PantryApi.Product? get() = null
    }
}

/**
 * The scan-into-pantry flow.
 *
 * ⚠️ **Live camera scanning is not available in this build.** iOS reads retail barcodes
 * with an `AVCaptureSession` metadata output (EAN-13/8, UPC-A/E, Code 128/39/93,
 * ITF-14); the Android equivalent is CameraX plus an ML Kit (or ZXing) barcode analyser,
 * and **neither library is in the version catalog, which is frozen after Phase 0**. A
 * feature module may not add catalog entries, so the camera path is deliberately left as
 * a clearly-labelled unavailable state rather than half-built or faked.
 *
 * Everything downstream of the barcode is complete and exercised: typed entry does the
 * same server lookup, the same confirm sheet, the same allergen warnings and the same
 * scan upsert. Typing the number is a genuine fallback, not a placeholder — plenty of
 * people do it by choice — so it is the primary action here rather than a footnote.
 *
 * **To finish this:** add CameraX + a barcode analyser to the catalog, then replace
 * [ScannerUnavailable] with a `PreviewView` + `ImageAnalysis` that calls `lookUp(code)`.
 * Nothing else in this file has to change.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryScanScreen(
    model: PantryModel,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val config = model.config

    var typing by remember { mutableStateOf(false) }
    var looking by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<ScanResult?>(null) }
    var lookupError by remember { mutableStateOf<String?>(null) }
    var addedCount by remember { mutableStateOf(0) }
    var addedEmojis by remember { mutableStateOf(emptyList<String>()) }

    /** Resolve a typed (or, once the camera lands, a scanned) code. */
    fun lookUp(raw: String) {
        if (result != null || looking) return
        val code = raw.filter { it.isDigit() }
        if (code.isEmpty()) return
        looking = true
        lookupError = null
        scope.launch {
            runCatching { model.api.lookup(code) }
                .onSuccess { product ->
                    result = if (product != null) {
                        ScanResult.Found(product, code)
                    } else {
                        ScanResult.NotFound(code)
                    }
                }
                // A throw here means the lookup itself failed — the product database is
                // unreachable — which is "try again", not "we don't have it".
                .onFailure {
                    lookupError = it.message
                        ?: "Couldn't look that up — add it by hand, or try again."
                }
            looking = false
        }
    }

    Box(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .padding(horizontal = 18.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(36.dp)
                        .background(WF.colors.panel, CircleShape)
                        .clip(CircleShape)
                        .clickable {
                            if (addedCount > 0) scope.launch { model.load() }
                            onClose()
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Close",
                        tint = WF.colors.ink,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Spacer(Modifier.width(12.dp))
                Column {
                    Text("Scan into pantry", style = WF.type.sectionTitle, color = WF.colors.ink)
                    Text(
                        "Type the barcode below",
                        style = WF.type.bodySmall,
                        color = WF.colors.ink3,
                    )
                }
            }

            Spacer(Modifier.weight(1f))

            lookupError?.let {
                DismissibleErrorBanner(it, { lookupError = null }, Modifier.padding(bottom = 16.dp))
            }

            ScannerUnavailable(onType = { typing = true })

            Spacer(Modifier.weight(1f))

            if (addedCount > 0) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    addedEmojis.takeLast(3).forEach { emoji ->
                        Box(
                            Modifier
                                .size(30.dp)
                                .background(WF.colors.panel, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(emoji, style = TextStyle(fontSize = 15.sp))
                        }
                    }
                    Text(
                        "$addedCount added",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink2,
                    )
                }
            }

            Box(Modifier.navigationBarsPadding().padding(bottom = 24.dp))
        }

        if (looking) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(WF.colors.scrim),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = WF.colors.onMedia)
            }
        }
    }

    if (typing) {
        ManualBarcodeSheet(
            onDismiss = { typing = false },
            onSubmit = { code ->
                typing = false
                lookUp(code)
            },
        )
    }

    result?.let { scanned ->
        PantryFoundSheet(
            result = scanned,
            locations = config.value.locations,
            avoid = model.avoidSet,
            allergenPeople = model.allergenPeople,
            api = model.api,
            onDismiss = { result = null },
            onLocationsChanged = { model.load() },
            onAdd = { body, emoji ->
                val outcome = runCatching { model.api.scan(body) }
                outcome
                    .onSuccess {
                        addedCount += 1
                        addedEmojis = addedEmojis + emoji
                    }
                    .onFailure { lookupError = "Couldn't save that item." }
                // Clearing the result re-arms the flow for the next barcode.
                result = null
            },
        )
    }
}

/**
 * The placeholder where the live camera preview belongs.
 *
 * Deliberately explicit about *why* there is no viewfinder — a silent absence reads as a
 * broken screen, and a fake one reads as a broken camera. The typed path underneath is
 * fully wired, so this screen still does its job today.
 */
@Composable
private fun ScannerUnavailable(onType: () -> Unit) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .border(
                    2.dp,
                    WF.colors.hair,
                    RoundedCornerShape(WF.radius.lg),
                )
                .padding(vertical = 34.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    Icons.Filled.QrCodeScanner,
                    contentDescription = null,
                    tint = WF.colors.ink3,
                    modifier = Modifier.size(44.dp),
                )
                Text(
                    "Camera scanning isn't available yet",
                    style = WF.type.label,
                    color = WF.colors.ink2,
                )
                Text(
                    "Type the barcode number instead — it does exactly the same lookup.",
                    style = WF.type.bodySmall,
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 24.dp),
                )
            }
        }
        Row(
            Modifier
                .background(WF.colors.primary, RoundedCornerShape(WF.radius.pill))
                .clip(RoundedCornerShape(WF.radius.pill))
                .clickable(onClick = onType)
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Keyboard,
                contentDescription = null,
                // White is correct on a saturated coloured fill.
                tint = Color.White,
                modifier = Modifier.size(16.dp),
            )
            Text(
                "Type a barcode",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                color = Color.White,
            )
        }
    }
}

/**
 * Typed barcode entry.
 *
 * The digits-only keyboard and the digits-only filter match what the server does with the
 * path segment, so a number copied off a receipt with spaces or dashes still resolves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ManualBarcodeSheet(
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    val digits = text.filter { it.isDigit() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .padding(horizontal = 20.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Type a barcode", style = WF.type.title, color = WF.colors.ink)
            SectionLabel("Barcode number")
            WaffledTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = "e.g. 0049000028200",
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Search,
                ),
                keyboardActions = KeyboardActions(
                    onSearch = { if (digits.isNotEmpty()) onSubmit(digits) },
                ),
            )
            Text(
                "We'll look it up in the product databases.",
                style = WF.type.caption,
                color = WF.colors.ink3,
            )
            WaffledPrimaryCTA(
                label = "Look up",
                onClick = { onSubmit(digits) },
                isDisabled = digits.isEmpty(),
            )
        }
    }
}
