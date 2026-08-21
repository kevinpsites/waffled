package app.waffled.feature.recipes

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.network.MediaImageEncoder
import app.waffled.core.network.WaffledApiException
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The recipe-import sheets reached from the editor's "start from…" bar — the Compose twins
 * of `apps/ios/.../Features/Meals/RecipeImportSheets.swift`.
 *
 * Each turns some input (photos of a physical recipe, a typed description, pasted
 * markdown) into the same [ParsedRecipe] draft the editor prefills from, then hands it
 * back. **Nothing is saved here** — the user reviews the filled form and saves as normal.
 *
 * Reuse, not reinvention: photos go through `MediaImageEncoder` (the shared upload
 * encoder) and the system photo picker, which needs no runtime permission.
 */

/** Up to this many photos of a single recipe (matches the web's `MAX_PHOTOS`). */
private const val MAX_RECIPE_PHOTOS = 6

/**
 * A friendly one-liner for an import failure.
 *
 * The server returns `{ error, message }` and `core:network` has already turned that into
 * a user-facing string, so relay it — it knows why the request failed and we don't.
 */
internal fun importErrorMessage(cause: Throwable?, fallback: String): String =
    (cause as? WaffledApiException)?.userMessage ?: fallback

/**
 * Snap or choose up to six photos of a recipe card, cookbook page or handwritten note;
 * the server's vision model reads them and fills the form.
 *
 * Only offered when `ingestConfig.vision` is true — a household with no vision-capable
 * model gets no button rather than a button that always fails.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PhotoImportSheet(
    api: RecipesApi,
    onDismiss: () -> Unit,
    onParsed: (ParsedRecipe) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var picks by remember { mutableStateOf(listOf<Uri>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        // The system photo picker — the Android twin of PHPicker, and like PHPicker it
        // needs no runtime permission.
        ActivityResultContracts.PickMultipleVisualMedia(MAX_RECIPE_PHOTOS),
    ) { uris -> picks = (picks + uris).distinct().take(MAX_RECIPE_PHOTOS) }

    ImportSheet(
        title = "Import from a photo",
        blurb = "Snap or choose a photo of a recipe card, cookbook page, or handwritten " +
            "note — even a few pages of one recipe. We’ll read it and fill the form. " +
            "Photos are held briefly, then deleted.",
        error = error,
        onDismiss = onDismiss,
    ) {
        if (picks.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                for (uri in picks) {
                    Box(Modifier.size(84.dp)) {
                        AsyncImage(
                            model = uri,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .fillMaxSize()
                                .clip(RoundedCornerShape(12.dp))
                                .border(1.dp, WF.colors.hair, RoundedCornerShape(12.dp)),
                        )
                        Icon(
                            Icons.Filled.Close,
                            "Remove photo",
                            // The badge sits ON a photo, so it uses the media pair.
                            tint = WF.colors.onMedia,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(3.dp)
                                .size(20.dp)
                                .background(WF.colors.scrim, androidx.compose.foundation.shape.CircleShape)
                                .clickable { picks = picks - uri }
                                .padding(3.dp),
                        )
                    }
                }
            }
        }

        if (picks.size < MAX_RECIPE_PHOTOS) {
            WaffledSecondaryCTA(
                label = if (picks.isEmpty()) "Choose photos" else "Add more",
                onClick = {
                    picker.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                },
            )
        }

        Text(
            "Under 10 MB each · up to $MAX_RECIPE_PHOTOS photos.",
            style = TextStyle(fontSize = 12.sp),
            color = WF.colors.ink3,
        )

        if (picks.isNotEmpty()) {
            WaffledPrimaryCTA(
                label = if (busy) "Reading…" else "Read ${picks.size} → fill the form",
                isBusy = busy,
                isDisabled = busy,
                tint = WF.colors.ai,
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val encoded = runCatching {
                            withContext(Dispatchers.IO) {
                                picks.map { MediaImageEncoder.encode(context, it) }
                                    .map { RecipesApi.EncodedImage(it.base64, it.contentType) }
                            }
                        }
                        val parsed = encoded.mapCatching { api.ingestPhotos(it) }
                        busy = false
                        parsed.fold(
                            onSuccess = onParsed,
                            onFailure = {
                                error = importErrorMessage(it, "Couldn’t read that — try a clearer photo.")
                            },
                        )
                    }
                },
            )
        }
    }
}

/**
 * Type (or dictate, using the keyboard's own microphone) a description of a recipe and let
 * the model turn it into a draft.
 *
 * Dictation is the **keyboard's**, not an in-app speech recogniser: Android's IME already
 * offers voice input on every text field, so adding `SpeechRecognizer` would be a second
 * microphone affordance, another permission prompt, and a dependency the catalog does not
 * carry. iOS needs `SFSpeechRecognizer` because its keyboard dictation is not guaranteed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DescribeRecipeSheet(
    api: RecipesApi,
    onDismiss: () -> Unit,
    onParsed: (ParsedRecipe) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ImportSheet(
        title = "Describe it",
        blurb = "Say or type it however you'd tell a friend — “chicken thighs with lemon " +
            "and olives, roast at 425 for 40 minutes” — and we'll turn it into a recipe " +
            "you can edit. Tap the microphone on your keyboard to dictate.",
        error = error,
        onDismiss = onDismiss,
    ) {
        WaffledTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = "Tell us about the recipe…",
            singleLine = false,
            minHeight = 160.dp,
        )
        WaffledPrimaryCTA(
            label = if (busy) "Thinking…" else "Turn it into a recipe",
            isBusy = busy,
            isDisabled = busy || text.isBlank(),
            tint = WF.colors.ai,
            onClick = {
                busy = true
                error = null
                scope.launch {
                    val parsed = runCatching { api.ingestVoice(text.trim()) }
                    busy = false
                    parsed.fold(
                        onSuccess = onParsed,
                        onFailure = {
                            error = importErrorMessage(it, "Couldn’t turn that into a recipe — try again.")
                        },
                    )
                }
            },
        )
    }
}

/**
 * Paste a Markdown recipe (frontmatter + body) and parse it into the form.
 *
 * Always offered, AI provider or not: this is the deterministic path, and the same parser
 * the web and the `just import-recipes` script use.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PasteMarkdownSheet(
    api: RecipesApi,
    onDismiss: () -> Unit,
    onParsed: (ParsedRecipe) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var markdown by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ImportSheet(
        title = "Paste a recipe",
        blurb = "Paste a Markdown recipe — frontmatter and all — and we’ll fill the form " +
            "from it. Nothing is saved until you review it.",
        error = error,
        onDismiss = onDismiss,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                "Use template",
                Modifier.clickable { markdown = MARKDOWN_TEMPLATE },
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.primary,
            )
        }
        WaffledTextField(
            value = markdown,
            onValueChange = { markdown = it },
            placeholder = "Paste frontmatter + markdown here…",
            singleLine = false,
            minHeight = 220.dp,
        )
        WaffledPrimaryCTA(
            label = if (busy) "Parsing…" else "Parse → fill",
            isBusy = busy,
            isDisabled = busy || markdown.isBlank(),
            onClick = {
                busy = true
                error = null
                scope.launch {
                    val parsed = runCatching { api.parseMarkdown(markdown) }
                    busy = false
                    parsed.fold(
                        onSuccess = onParsed,
                        onFailure = {
                            error = importErrorMessage(
                                it,
                                "Couldn’t parse that — check the format and try again.",
                            )
                        },
                    )
                }
            },
        )
    }
}

/** The shared chrome of the three import sheets. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ImportSheet(
    title: String,
    blurb: String,
    error: String?,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(title, style = WF.type.title, color = WF.colors.ink)
            Text(blurb, style = TextStyle(fontSize = 13.5.sp), color = WF.colors.ink2)
            content()
            error?.let {
                Text(
                    it,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.primaryD,
                )
            }
            WaffledSecondaryCTA("Cancel", onDismiss)
        }
    }
}

private val MARKDOWN_TEMPLATE = """
---
type: dinner
protein: chicken
cuisine: Italian
effort: weeknight
dietary: [gluten-free]
vegetables: [spinach]
tags: [family-favorite]
---

# Recipe title

*4 servings*

## Ingredients

### Section name
- 1 lb main ingredient, prepped
- 2 tbsp something

## Instructions

1. First step.
2. Second step.

## Notes

Anything worth remembering.
""".trimIndent()
