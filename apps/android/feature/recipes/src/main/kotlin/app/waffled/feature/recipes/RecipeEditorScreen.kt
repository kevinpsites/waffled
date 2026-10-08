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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledSecondaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.core.network.MediaImageEncoder
import app.waffled.core.network.MediaUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * Create or edit a recipe — the phone layout of iOS `RecipeEditorView`.
 *
 * The basics, the AI-assisted Details (which auto-fill cuisine / protein / tags from the
 * title + ingredients + steps), the ingredient rows with their section names, and the
 * method steps — including the web's "ingredients used per step" with an editable per-step
 * amount ("½ the soy sauce here, the rest later").
 *
 * Everything that has a rule lives in [RecipeEditorDraft], which is where the two quiet
 * traps are tested: clearing the photo must null the storage key, and every optional field
 * must go out explicitly because the save REPLACES.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RecipeEditorScreen(
    api: RecipesApi,
    modifier: Modifier = Modifier,
    /** null ⇒ creating a new recipe. */
    editing: RecipeDetailDTO? = null,
    baseUrl: String = "",
    onCancel: () -> Unit = {},
    onSaved: (RecipeSummary) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val uid = remember { { UUID.randomUUID().toString() } }

    var draft by remember(editing?.recipe?.id) {
        mutableStateOf(
            if (editing == null) RecipeEditorDraft.create(uid) else RecipeEditorDraft.edit(editing, uid),
        )
    }
    var saving by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var usedSections by remember { mutableStateOf(emptyList<String>()) }
    var ingestConfig by remember { mutableStateOf<RecipeIngestConfig?>(null) }
    var suggestion by remember { mutableStateOf<RecipeMetadataSuggestion?>(null) }
    var uploadingPhoto by remember { mutableStateOf(false) }
    var showPaste by remember { mutableStateOf(false) }
    var showPhotoImport by remember { mutableStateOf(false) }
    var showDescribe by remember { mutableStateOf(false) }
    val isCreating = draft.editingId == null

    // The household's existing section names, for the section autocomplete.
    LaunchedEffect(Unit) { usedSections = runCatching { api.sections() }.getOrNull().orEmpty() }
    // Which AI import paths this household can use. Failure → null, so only "Paste
    // markdown" shows, which is the graceful answer when no provider is configured.
    LaunchedEffect(isCreating) {
        if (isCreating) ingestConfig = runCatching { api.ingestConfig() }.getOrNull()
    }

    // Debounced AI Details auto-fill, restarted whenever the recipe's shape changes.
    // `suggestMetadata` never throws — no provider means no suggestions, not an error.
    val signature = remember(draft.title, draft.ingredients, draft.steps) {
        draft.title + "|" + draft.ingredients.joinToString { it.name } + "|" +
            draft.steps.joinToString { it.instruction }
    }
    LaunchedEffect(signature) {
        if (draft.title.isBlank()) return@LaunchedEffect
        delay(900)
        suggestion = api.suggestMetadata(
            draft.title.trim(),
            draft.ingredients.filterNot { it.isBlank }.map { it.name },
            draft.steps.filterNot { it.isBlank }.map { it.instruction },
        )
    }

    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        uploadingPhoto = true
        scope.launch {
            // Encoded with the SHARED encoder — it downscales, walks a JPEG quality ladder
            // and stays under the server's 10 MB cap. Never roll another one.
            val encoded = runCatching {
                withContext(Dispatchers.IO) { MediaImageEncoder.encode(context, uri) }
            }.getOrNull()
            if (encoded == null) {
                errorText = "That image is too large to upload. Try a smaller photo."
            } else {
                val up = runCatching { api.uploadMedia(encoded.base64, encoded.contentType) }.getOrNull()
                if (up == null) {
                    errorText = "Couldn’t upload that photo."
                } else {
                    draft = draft.copy(
                        storageKey = up.key,
                        contentType = up.contentType,
                        imageUrl = up.url,
                    )
                }
            }
            uploadingPhoto = false
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .statusBarsPadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Cancel",
                modifier = Modifier.clickable(onClick = onCancel),
                style = TextStyle(fontSize = 15.sp),
                color = WF.colors.ink2,
            )
            Text(
                text = if (isCreating) "New recipe" else "Edit recipe",
                modifier = Modifier.weight(1f),
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Text(
                text = if (saving) "Saving…" else "Save",
                modifier = Modifier.clickable(enabled = draft.canSave && !saving) {
                    saving = true
                    errorText = null
                    scope.launch {
                        val id = draft.editingId
                        val saved = runCatching {
                            if (id == null) api.createRecipe(draft.body())
                            else api.saveRecipeContent(id, draft.body())
                        }.getOrNull()
                        saving = false
                        if (saved == null) errorText = "Couldn’t save the recipe — please try again."
                        else onSaved(saved)
                    }
                },
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = if (draft.canSave && !saving) WF.colors.primary else WF.colors.ink3,
            )
        }

        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            errorText?.let {
                Text(
                    it,
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.primaryD,
                )
            }

            // "Build it by hand, or start from…" — new recipes only. Paste-markdown is
            // always offered; the AI paths appear only when the household's provider
            // supports them.
            if (isCreating) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "Build it by hand, or start from…",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink3,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (ingestConfig?.vision == true) {
                            OutlinePill("📷  From a photo") { showPhotoImport = true }
                        }
                        if (ingestConfig?.text == true) {
                            OutlinePill("🎙  Describe it") { showDescribe = true }
                        }
                        OutlinePill("📋  Paste markdown") { showPaste = true }
                    }
                }
            }

            // ---- basics ----
            EditorCard("Basics") {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    WaffledTextField(
                        value = draft.emoji,
                        onValueChange = { draft = draft.copy(emoji = it.take(2)) },
                        label = "EMOJI",
                        placeholder = "🌮",
                        modifier = Modifier.width(84.dp),
                    )
                    WaffledTextField(
                        value = draft.title,
                        onValueChange = { draft = draft.copy(title = it) },
                        label = "TITLE",
                        placeholder = "What are you making?",
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    NumberField("SERVES", draft.servings, Modifier.weight(1f)) {
                        draft = draft.copy(servings = it)
                    }
                    NumberField("PREP (MIN)", draft.prep, Modifier.weight(1f)) {
                        draft = draft.copy(prep = it)
                    }
                    NumberField("COOK (MIN)", draft.cook, Modifier.weight(1f)) {
                        draft = draft.copy(cook = it)
                    }
                }
                PhotoField(
                    resolvedUrl = MediaUrl.resolve(draft.imageUrl, baseUrl),
                    cacheKey = MediaUrl.cacheKey(draft.imageUrl),
                    emoji = draft.emoji.ifEmpty { null },
                    uploading = uploadingPhoto,
                    onPick = {
                        photoPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                        )
                    },
                    onClear = {
                        // Both, always: clearing only the URL leaves the stored blob
                        // winning and "remove the image" does nothing.
                        draft = draft.copy(imageUrl = "", storageKey = null, contentType = null)
                    },
                )
            }

            // ---- details ----
            EditorCard("Details") {
                for (field in RecipeEditorDraft.SCALAR_FIELDS) {
                    val suggested = suggestion?.valueFor(field.key)
                    WaffledTextField(
                        value = draft.meta[field.key].orEmpty(),
                        onValueChange = { draft = draft.copy(meta = draft.meta + (field.key to it)) },
                        label = field.label,
                        placeholder = field.placeholder,
                    )
                    if (!suggested.isNullOrBlank() && draft.meta[field.key].isNullOrBlank()) {
                        SuggestionChip(suggested) {
                            draft = draft.copy(meta = draft.meta + (field.key to suggested))
                        }
                    }
                }
                ChipEditorField(
                    label = "DIETARY",
                    items = draft.dietary,
                    placeholder = "vegetarian, gluten-free…",
                    suggestions = suggestion?.dietary.orEmpty() - draft.dietary.toSet(),
                    onChange = { draft = draft.copy(dietary = it) },
                )
                ChipEditorField(
                    label = "VEGETABLES",
                    items = draft.vegetables,
                    placeholder = "spinach, onion…",
                    suggestions = suggestion?.vegetables.orEmpty() - draft.vegetables.toSet(),
                    onChange = { draft = draft.copy(vegetables = it) },
                )
                ChipEditorField(
                    label = "TAGS",
                    items = draft.tags,
                    placeholder = "family-favorite…",
                    suggestions = suggestion?.tags.orEmpty() - draft.tags.toSet(),
                    onChange = { draft = draft.copy(tags = it) },
                )
            }

            // ---- ingredients ----
            EditorCard("Ingredients") {
                draft.ingredients.forEachIndexed { i, ing ->
                    IngredientRowView(
                        ingredient = ing,
                        sections = remember(usedSections) {
                            (RecipeEditorDraft.DEFAULT_SECTIONS + usedSections).distinct()
                        },
                        controls = EditorRowControls(
                            canMoveUp = i > 0,
                            canMoveDown = i < draft.ingredients.lastIndex,
                            onMoveUp = { draft = draft.copy(ingredients = draft.ingredients.swapped(i, i - 1)) },
                            onMoveDown = { draft = draft.copy(ingredients = draft.ingredients.swapped(i, i + 1)) },
                            onDelete = {
                                val next = draft.ingredients.filterNot { it.uid == ing.uid }
                                draft = draft.copy(
                                    ingredients = next.ifEmpty { listOf(EditIngredient(uid())) },
                                    // A step pointing at a deleted row would compose a
                                    // blank line; drop those picks with it.
                                    steps = draft.steps.map { s ->
                                        s.copy(picks = s.picks.filterNot { it.ingredientUid == ing.uid })
                                    },
                                )
                            },
                        ),
                        onChange = { updated ->
                            draft = draft.copy(
                                ingredients = draft.ingredients.map { if (it.uid == ing.uid) updated else it },
                            )
                        },
                    )
                }
                AddRowButton("＋ Add ingredient") {
                    draft = draft.copy(ingredients = draft.ingredients + EditIngredient(uid()))
                }
            }

            // ---- method ----
            EditorCard("Method") {
                draft.steps.forEachIndexed { i, step ->
                    MethodStepRow(
                        number = i + 1,
                        step = step,
                        ingredients = draft.ingredients.filterNot { it.isBlank },
                        controls = EditorRowControls(
                            canMoveUp = i > 0,
                            canMoveDown = i < draft.steps.lastIndex,
                            onMoveUp = { draft = draft.copy(steps = draft.steps.swapped(i, i - 1)) },
                            onMoveDown = { draft = draft.copy(steps = draft.steps.swapped(i, i + 1)) },
                            onDelete = {
                                val next = draft.steps.filterNot { it.uid == step.uid }
                                draft = draft.copy(steps = next.ifEmpty { listOf(EditStep(uid())) })
                            },
                        ),
                        onChange = { updated ->
                            draft = draft.copy(steps = draft.steps.map { if (it.uid == step.uid) updated else it })
                        },
                    )
                }
                AddRowButton("＋ Add step") {
                    draft = draft.copy(steps = draft.steps + EditStep(uid()))
                }
            }

            // ---- notes ----
            EditorCard("Notes") {
                WaffledTextField(
                    value = draft.notes,
                    onValueChange = { draft = draft.copy(notes = it) },
                    placeholder = "Anything worth remembering.",
                    singleLine = false,
                    minHeight = 80.dp,
                )
            }
        }
    }

    if (showPaste) {
        PasteMarkdownSheet(
            api = api,
            onDismiss = { showPaste = false },
            onParsed = {
                draft = RecipeEditorDraft.hydrated(draft, it, uid)
                showPaste = false
            },
        )
    }
    if (showPhotoImport) {
        PhotoImportSheet(
            api = api,
            onDismiss = { showPhotoImport = false },
            onParsed = {
                draft = RecipeEditorDraft.hydrated(draft, it, uid)
                showPhotoImport = false
            },
        )
    }
    if (showDescribe) {
        DescribeRecipeSheet(
            api = api,
            onDismiss = { showDescribe = false },
            onParsed = {
                draft = RecipeEditorDraft.hydrated(draft, it, uid)
                showDescribe = false
            },
        )
    }
}

/** The move/delete cluster every editable row carries. */
@androidx.compose.runtime.Immutable
data class EditorRowControls(
    val canMoveUp: Boolean,
    val canMoveDown: Boolean,
    val onMoveUp: () -> Unit,
    val onMoveDown: () -> Unit,
    val onDelete: () -> Unit,
)

/**
 * One editable ingredient: amount, unit, name, prep note and its section.
 *
 * Reordering is up/down buttons, not drag: Compose has no `.onMove` for a `Column`, and
 * hand-rolling drag-and-drop is the unbudgeted subproject that burned iOS twice. The
 * *rule* (see [PlateReorder]) is ported; the gesture is not.
 */
@Composable
fun IngredientRowView(
    ingredient: EditIngredient,
    sections: List<String>,
    controls: EditorRowControls,
    onChange: (EditIngredient) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card2, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WaffledTextField(
                value = ingredient.amount,
                onValueChange = { onChange(ingredient.copy(amount = it)) },
                placeholder = "2",
                modifier = Modifier.width(64.dp),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            )
            WaffledTextField(
                value = ingredient.unit,
                onValueChange = { onChange(ingredient.copy(unit = it)) },
                placeholder = "cup",
                modifier = Modifier.width(80.dp),
            )
            WaffledTextField(
                value = ingredient.name,
                onValueChange = { onChange(ingredient.copy(name = it)) },
                placeholder = "flour",
                modifier = Modifier.weight(1f),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            WaffledTextField(
                value = ingredient.prepNote,
                onValueChange = { onChange(ingredient.copy(prepNote = it)) },
                placeholder = "sifted",
                modifier = Modifier.weight(1f),
            )
            RowControls(controls)
        }
        SectionInput(
            value = ingredient.section,
            options = sections,
            onChange = { onChange(ingredient.copy(section = it)) },
        )
    }
}

/**
 * The ingredient's section name, with the household's own names offered as chips.
 *
 * Free text with suggestions rather than a picker: sections are free text server-side, and
 * a closed list would make "For the slaw" impossible to type.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SectionInput(
    value: String,
    options: List<String>,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            WaffledTextField(
                value = value,
                onValueChange = onChange,
                label = "SECTION",
                placeholder = "Produce, For the sauce…",
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = if (open) "Hide suggestions" else "Show section suggestions",
                tint = WF.colors.ink3,
                modifier = Modifier.size(32.dp).clickable { open = !open }.padding(8.dp),
            )
        }
        if (open) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (s in options) {
                    Text(
                        text = s,
                        modifier = Modifier
                            .wfChip(s.equals(value, ignoreCase = true))
                            .clickable { onChange(s); open = false }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink2,
                    )
                }
            }
        }
    }
}

/** One editable method step: the instruction, its per-step ingredients, and its timer. */
@Composable
fun MethodStepRow(
    number: Int,
    step: EditStep,
    ingredients: List<EditIngredient>,
    controls: EditorRowControls,
    onChange: (EditStep) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .background(WF.colors.card2, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(28.dp).background(WF.colors.panel, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "$number",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink2,
                )
            }
            Spacer(Modifier.weight(1f))
            RowControls(controls)
        }
        WaffledTextField(
            value = step.instruction,
            onValueChange = { onChange(step.copy(instruction = it)) },
            placeholder = "What happens at this step?",
            singleLine = false,
            minHeight = 60.dp,
        )
        StepTagSection(step = step, ingredients = ingredients, onChange = onChange)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            NumberField(
                label = "TIMER (SEC)",
                value = step.timerSeconds?.toString().orEmpty(),
                modifier = Modifier.width(120.dp),
            ) { onChange(step.copy(timerSeconds = it.toIntOrNull()?.takeIf { n -> n > 0 })) }
            step.timerSeconds?.takeIf { it > 0 }?.let {
                Text(
                    "= ${CookTimer.mmss(it)}",
                    Modifier.padding(bottom = 12.dp),
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                )
            }
        }
    }
}

/**
 * "Ingredients used at this step", each with its own editable amount.
 *
 * The per-step amount is the point: half the soy sauce here, the rest later. Tapping an
 * ingredient toggles it on or off the step; the amount field appears once it is on.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StepTagSection(
    step: EditStep,
    ingredients: List<EditIngredient>,
    onChange: (EditStep) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (ingredients.isEmpty()) return
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel("Uses")
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (ing in ingredients) {
                val on = step.picks.any { it.ingredientUid == ing.uid }
                Text(
                    text = ing.name,
                    modifier = Modifier
                        .wfChip(on)
                        .clickable {
                            onChange(
                                if (on) step.copy(picks = step.picks.filterNot { it.ingredientUid == ing.uid })
                                else step.copy(picks = step.picks + StepPick(ing.uid, "")),
                            )
                        }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                    color = if (on) WF.colors.primary else WF.colors.ink2,
                )
            }
        }
        for (pick in step.picks) {
            val name = ingredients.firstOrNull { it.uid == pick.ingredientUid }?.name ?: continue
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                WaffledTextField(
                    value = pick.amount,
                    onValueChange = { amt ->
                        onChange(
                            step.copy(
                                picks = step.picks.map {
                                    if (it.ingredientUid == pick.ingredientUid) it.copy(amount = amt) else it
                                },
                            ),
                        )
                    },
                    placeholder = "how much here",
                    modifier = Modifier.width(140.dp),
                )
                Text(name, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink2)
            }
        }
    }
}

/**
 * A chips + add-field editor with AI suggestion chips underneath.
 *
 * Suggestions are marked ✨ and tinted `ai`, matching every other AI affordance in the
 * app, so it is always clear which values a model proposed rather than the household.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipEditorField(
    label: String,
    items: List<String>,
    placeholder: String,
    onChange: (List<String>) -> Unit,
    modifier: Modifier = Modifier,
    suggestions: List<String> = emptyList(),
) {
    var draft by remember { mutableStateOf("") }

    fun commit() {
        val v = draft.trim().lowercase()
        if (v.isNotEmpty() && v !in items) onChange(items + v)
        draft = ""
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        SectionLabel(label)
        if (items.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                for (it2 in items) {
                    TagChip(it2, onRemove = { onChange(items.filterNot { v -> v == it2 }) })
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
            WaffledTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = placeholder,
                modifier = Modifier.weight(1f),
            )
            if (draft.isNotBlank()) {
                Text(
                    "Add",
                    Modifier.clickable { commit() }.padding(bottom = 12.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.primary,
                )
            }
        }
        if (suggestions.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                for (s in suggestions) SuggestionChip(s) { onChange(items + s) }
            }
        }
    }
}

@Composable
private fun SuggestionChip(value: String, onAccept: () -> Unit) {
    Text(
        text = "✨ $value",
        modifier = Modifier
            .background(WF.colors.ai.copy(alpha = 0.10f), RoundedCornerShape(WF.radius.pill))
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(onClick = onAccept)
            .padding(horizontal = 9.dp, vertical = 5.dp),
        style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ai,
    )
}

@Composable
private fun RowControls(controls: EditorRowControls) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        GlyphButton(Icons.Filled.KeyboardArrowUp, "Move up", controls.canMoveUp, controls.onMoveUp)
        GlyphButton(Icons.Filled.KeyboardArrowDown, "Move down", controls.canMoveDown, controls.onMoveDown)
        GlyphButton(Icons.Filled.Delete, "Delete row", true, controls.onDelete, WF.colors.danger)
    }
}

@Composable
private fun GlyphButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    tint: Color = WF.colors.ink2,
) {
    Box(
        Modifier
            .size(30.dp)
            .background(WF.colors.panel, CircleShape)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            label,
            tint = if (enabled) tint else WF.colors.ink3.copy(alpha = 0.4f),
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun AddRowButton(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        modifier = Modifier
            .fillMaxWidth()
            .border(
                1.dp,
                WF.colors.hair,
                RoundedCornerShape(WF.radius.md),
            )
            .clip(RoundedCornerShape(WF.radius.md))
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
        color = WF.colors.ink2,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
}

@Composable
private fun OutlinePill(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        modifier = Modifier
            .background(WF.colors.card, RoundedCornerShape(WF.radius.pill))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.pill))
            .clip(RoundedCornerShape(WF.radius.pill))
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink,
    )
}

@Composable
private fun NumberField(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    onChange: (String) -> Unit,
) {
    WaffledTextField(
        value = value,
        onValueChange = { onChange(it.filter(Char::isDigit)) },
        label = label,
        placeholder = "—",
        modifier = modifier,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun EditorCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                title,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            content()
        }
    }
}

/** The recipe photo: a preview with a change / remove pair, or an empty picker tile. */
@Composable
private fun PhotoField(
    resolvedUrl: String?,
    cacheKey: String?,
    emoji: String?,
    uploading: Boolean,
    onPick: () -> Unit,
    onClear: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("Photo")
        Box(Modifier.fillMaxWidth().height(140.dp).clip(RoundedCornerShape(WF.radius.md))) {
            RecipeHero(
                imageUrl = resolvedUrl,
                cacheKey = cacheKey,
                emoji = emoji,
                category = null,
                height = 140.dp,
                emojiSize = 40,
            )
            if (uploading) {
                Box(
                    Modifier.fillMaxSize().background(WF.colors.scrim),
                    contentAlignment = Alignment.Center,
                ) {
                    // White on the scrim, like every other caption over media.
                    CircularProgressIndicator(color = WF.colors.onMedia, strokeWidth = 2.dp)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.weight(1f)) {
                WaffledSecondaryCTA(if (resolvedUrl == null) "Choose a photo" else "Change photo", onPick)
            }
            if (resolvedUrl != null) {
                Box(Modifier.weight(1f)) { WaffledSecondaryCTA("Remove", onClear) }
            }
        }
    }
}

private fun <T> List<T>.swapped(a: Int, b: Int): List<T> {
    if (a !in indices || b !in indices) return this
    return toMutableList().also { it[a] = this[b]; it[b] = this[a] }
}

/** The scalar Details value a suggestion offers for one field key. */
private fun RecipeMetadataSuggestion.valueFor(key: String): String? = when (key) {
    "cuisine" -> cuisine
    "protein" -> protein
    "mealType" -> mealType
    "base" -> base
    "effort" -> effort
    "cookMethod" -> cookMethod
    "flavorProfile" -> flavorProfile
    else -> null
}
