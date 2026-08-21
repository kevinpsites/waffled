package app.waffled.feature.recipes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledIcons
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfShadow3
import kotlinx.coroutines.launch

/**
 * Full-screen recipe detail — the phone layout of iOS `RecipeDetailView`.
 *
 * Hero, title + metadata chips, a cooked tally, the Cook button, the ingredient list with
 * a servings scaler and an "on hand" banner, the numbered method (each step note-able),
 * and your-notes. Tags, notes and substitutions are editable here; they read-modify-write
 * the recipe's overrides blob (see [RecipeOverrideEdits]).
 *
 * **Scope:** phone layout only — the iPad two-column split is not ported.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RecipeDetailScreen(
    model: RecipeDetailModel,
    modifier: Modifier = Modifier,
    onBack: () -> Unit = {},
    /** Hand the loaded recipe to the app-level cook session. */
    onCook: (RecipeDetailModel.State) -> Unit = {},
    /** Open the editor seeded with this recipe. */
    onEdit: ((RecipeDetailDTO) -> Unit)? = null,
    /** Open the Meal Builder with this recipe already the plate's main. */
    onBuildMealAround: ((RecipeSummary) -> Unit)? = null,
    /** Hand compiled Markdown to the platform share sheet. */
    onShare: ((RecipeMarkdown) -> Unit)? = null,
    /** Jump straight into Cook Mode once the steps load. */
    autoCook: Boolean = false,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val r = state.recipe

    var showMenu by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var scheduling by remember { mutableStateOf(false) }
    var pickingGrocery by remember { mutableStateOf(false) }
    var editingTags by remember { mutableStateOf(false) }
    var stepNoteFor by remember { mutableStateOf<Int?>(null) }
    var subFor by remember { mutableStateOf<RecipeIngredientDTO?>(null) }
    var tagsExpanded by remember { mutableStateOf(false) }
    var sharePreparing by remember { mutableStateOf(false) }
    var notesDraft by remember(r.id) { mutableStateOf(r.userNotes.orEmpty()) }

    LaunchedEffect(model.id) {
        model.load()
        // Feeds the library's "Recently viewed" rail. Once per visit.
        model.recordView()
        if (autoCook && model.state.value.steps.isNotEmpty()) onCook(model.state.value)
    }

    Column(
        modifier
            .fillMaxSize()
            .background(WF.colors.canvas)
            .statusBarsPadding(),
    ) {
        // A plain top row rather than Material3's TopAppBar: this screen is pushed inside
        // a host that owns its own chrome, and the M3 bar draws from a colour scheme this
        // app deliberately does not populate.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.ArrowBack,
                "Back",
                tint = WF.colors.ink2,
                modifier = Modifier.size(36.dp).clip(CircleShape).clickable(onClick = onBack).padding(8.dp),
            )
            Spacer(Modifier.weight(1f))
            Icon(
                imageVector = if (r.isFavorite) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                contentDescription = if (r.isFavorite) "Unfavourite" else "Favourite",
                tint = if (r.isFavorite) WF.colors.primary else WF.colors.ink2,
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .clickable { scope.launch { model.toggleFavorite() } }
                    .padding(8.dp),
            )
            Box {
                Icon(
                    Icons.Filled.MoreVert,
                    "More",
                    tint = WF.colors.ink2,
                    modifier = Modifier.size(36.dp).clip(CircleShape).clickable { showMenu = true }.padding(8.dp),
                )
                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false },
                    containerColor = WF.colors.card,
                ) {
                    MenuRow("📅  Schedule…") { showMenu = false; scheduling = true }
                    // Disabled until the ingredients land: this menu is live from the
                    // first frame, while the sheet builds its whole state from them, so
                    // an early tap opened it empty. See RecipeGroceryPick.canAdd.
                    MenuRow("🛒  Add to grocery list", enabled = RecipeGroceryPick.canAdd(state.ingredients)) {
                        showMenu = false
                        pickingGrocery = true
                    }
                    MenuRow("🏷️  Tags & dietary") { showMenu = false; editingTags = true }
                    onBuildMealAround?.let {
                        MenuRow("🍽️  Build a meal around this") { showMenu = false; it(r) }
                    }
                    onShare?.let { share ->
                        MenuRow(
                            if (sharePreparing) "⏳  Preparing…" else "↗  Share recipe",
                            enabled = !sharePreparing,
                        ) {
                            showMenu = false
                            sharePreparing = true
                            scope.launch {
                                model.shareMarkdown()?.let(share)
                                sharePreparing = false
                            }
                        }
                    }
                    onEdit?.let {
                        MenuRow("✏️  Edit recipe") {
                            showMenu = false
                            it(RecipeDetailDTO(r, state.ingredients, state.steps))
                        }
                    }
                    MenuRow("🗑  Delete recipe", destructive = true) {
                        showMenu = false
                        confirmingDelete = true
                    }
                }
            }
        }

        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                // Screens scroll UNDER the tab bar.
                .padding(bottom = WF.spacing.tabBarClearance),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            RecipeHero(
                imageUrl = model.heroUrl,
                cacheKey = model.heroCacheKey,
                emoji = r.emoji,
                category = r.category,
                modifier = Modifier.clip(RoundedCornerShape(WF.radius.lg)),
                height = 190.dp,
                emojiSize = 64,
            )

            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(r.title, style = WF.type.hero, color = WF.colors.ink)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    // Prep + cook broken out here; the library card shows the combined total.
                    r.prepTimeMinutes?.let { MetaBit("🔪", "$it min prep") }
                    r.cookTimeMinutes?.let { MetaBit("🔥", "$it min cook") }
                    MetaBit("🍽️", "Serves ${model.baseServings}")
                    if (state.steps.isNotEmpty()) MetaBit("🪜", "${state.steps.size} steps")
                    r.sourceName?.let { MetaBit("📖", it) }
                }

                // Progressive disclosure: three chips + a "+N more" toggle, with the
                // free-text hashtags on a quiet line beneath — so the tags stop shouting
                // over the recipe.
                val all = model.chips
                val shown = if (tagsExpanded) all else all.take(3)
                if (all.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                        verticalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        for (c in shown) TagChip(c.text, style = c.style)
                        if (all.size > 3) {
                            Text(
                                text = if (tagsExpanded) "Show less" else "+${all.size - shown.size} more",
                                modifier = Modifier
                                    .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.pill))
                                    .clip(RoundedCornerShape(WF.radius.pill))
                                    .clickable { tagsExpanded = !tagsExpanded }
                                    .padding(horizontal = 11.dp, vertical = 6.dp),
                                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                                color = WF.colors.ink3,
                            )
                        }
                    }
                }
                if (model.hashtags.isNotEmpty()) {
                    Text(
                        text = model.hashtags.joinToString(" · ") { "#$it" },
                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.ink3,
                    )
                }
            }

            // The one primary action — the first thing your eye lands on after the title.
            if (state.steps.isNotEmpty()) {
                val shape = RoundedCornerShape(WF.radius.pill)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .wfShadow3(shape)
                        .background(WF.colors.ink, shape)
                        .clip(shape)
                        .clickable { onCook(state) }
                        .padding(vertical = 16.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("👨‍🍳", style = TextStyle(fontSize = 18.sp))
                    Spacer(Modifier.width(9.dp))
                    Text(
                        "Cook Mode",
                        style = TextStyle(fontSize = 16.5.sp, fontWeight = FontWeight.Black),
                        // On a solid `ink` fill, never literal white.
                        color = WF.colors.onInk,
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = state.message
                        ?: if (r.cookedCount > 0) "👨‍🍳 Cooked ${r.cookedCount}×" else "Not cooked yet",
                    modifier = Modifier.weight(1f),
                    style = TextStyle(
                        fontSize = 13.sp,
                        fontWeight = if (state.message != null) FontWeight.SemiBold else FontWeight.Medium,
                    ),
                    color = if (state.message != null) WF.colors.primary else WF.colors.ink3,
                )
                Text(
                    text = "✓ Mark cooked",
                    modifier = Modifier
                        .background(WF.colors.panel, RoundedCornerShape(WF.radius.pill))
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable { scope.launch { model.markCooked() } }
                        .padding(horizontal = 13.dp, vertical = 8.dp),
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink,
                )
            }

            when {
                state.loading && state.ingredients.isEmpty() && state.steps.isEmpty() ->
                    WaffledLoading(top = 30.dp)

                state.error && state.ingredients.isEmpty() -> Text(
                    text = "Couldn’t load this recipe.",
                    modifier = Modifier.fillMaxWidth().padding(vertical = 20.dp),
                    style = TextStyle(fontSize = 14.sp),
                    color = WF.colors.ink3,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )

                else -> {
                    if (state.ingredients.isNotEmpty()) {
                        IngredientsCard(
                            model = model,
                            state = state,
                            onToggle = model::toggleChecked,
                            onSub = { subFor = it },
                        )
                        OnHandBannerRow(model.banner()) { pickingGrocery = true }
                    }
                    if (state.steps.isNotEmpty()) {
                        MethodCard(state.steps, model::noteFor) { stepNoteFor = it }
                    }
                    NotesCard(
                        notes = r.notes,
                        draft = notesDraft,
                        saved = r.userNotes.orEmpty(),
                        onDraft = { notesDraft = it },
                        onSave = { scope.launch { model.saveNotes(notesDraft) } },
                    )
                }
            }
        }
    }

    // ---- sheets ----------------------------------------------------------------

    if (scheduling) {
        RecipeScheduleSheet(
            title = r.title,
            onDismiss = { scheduling = false },
            onSchedule = { date, mealType -> model.schedule(date, mealType) },
        )
    }

    if (pickingGrocery) {
        RecipeGrocerySheet(
            title = r.title,
            ingredients = state.ingredients,
            ratio = model.ratio,
            onDismiss = { pickingGrocery = false },
            onAdd = { ids -> scope.launch { model.addToGrocery(ids) } },
        )
    }

    stepNoteFor?.let { step ->
        StepNoteSheet(
            stepNumber = step,
            note = model.noteFor(step),
            onDismiss = { stepNoteFor = null },
            onSave = { text -> scope.launch { model.saveStepNote(step, text) } },
        )
    }

    subFor?.let { ing ->
        IngredientSubSheet(
            ingredientName = ing.name,
            sub = model.subFor(ing),
            onDismiss = { subFor = null },
            onSave = { text -> scope.launch { model.saveSub(ing.name, text) } },
        )
    }

    if (editingTags) {
        TagsEditorSheet(
            tags = r.addedTags.orEmpty(),
            dietary = r.dietary.orEmpty(),
            onDismiss = { editingTags = false },
            onSave = { tags, dietary -> scope.launch { model.saveTags(tags, dietary) } },
        )
    }

    if (confirmingDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            containerColor = WF.colors.card,
            title = { Text("Delete this recipe?", color = WF.colors.ink) },
            text = {
                Text(
                    "This removes “${r.title}” from your recipe library. This can’t be undone.",
                    color = WF.colors.ink2,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingDelete = false
                    scope.launch { if (model.delete()) onBack() }
                }) {
                    Text("Delete recipe", color = WF.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }) {
                    Text("Cancel", color = WF.colors.ink2)
                }
            },
        )
    }
}

@Composable
private fun MenuRow(
    label: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = {
            Text(
                label,
                color = when {
                    !enabled -> WF.colors.ink3
                    destructive -> WF.colors.danger
                    else -> WF.colors.ink
                },
            )
        },
        enabled = enabled,
        onClick = onClick,
    )
}

@Composable
private fun IngredientsCard(
    model: RecipeDetailModel,
    state: RecipeDetailModel.State,
    onToggle: (String) -> Unit,
    onSub: (RecipeIngredientDTO) -> Unit,
) {
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Ingredients",
                    Modifier.weight(1f),
                    style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Servings",
                        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink3,
                    )
                    ScalerGlyph(Icons.Filled.Remove, "Fewer servings") {
                        model.setServings(model.currentServings - 1)
                    }
                    Text(
                        "${model.currentServings}",
                        Modifier.widthIn(min = 18.dp),
                        style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    ScalerGlyph(Icons.Filled.Add, "More servings") {
                        model.setServings(model.currentServings + 1)
                    }
                }
            }
            state.ingredients.forEachIndexed { i, ing ->
                IngredientRow(
                    ing = ing,
                    amount = model.amountText(ing),
                    name = model.subFor(ing) ?: model.nameText(ing),
                    sub = model.subFor(ing),
                    checked = ing.id in state.checked,
                    onToggle = { onToggle(ing.id) },
                    onSub = { onSub(ing) },
                )
                if (i < state.ingredients.lastIndex) HorizontalDivider(color = WF.colors.hair)
            }
        }
    }
}

@Composable
private fun ScalerGlyph(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier.size(26.dp).background(WF.colors.panel, CircleShape).clip(CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = WF.colors.ink, modifier = Modifier.size(12.dp))
    }
}

@Composable
private fun IngredientRow(
    ing: RecipeIngredientDTO,
    amount: String,
    name: String,
    sub: String?,
    checked: Boolean,
    onToggle: () -> Unit,
    onSub: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().alpha(if (checked) 0.6f else 1f),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = if (checked) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
            contentDescription = if (checked) "Uncheck $name" else "Check off $name",
            tint = if (checked) WF.colors.primary else WF.colors.ink3.copy(alpha = 0.55f),
            modifier = Modifier.size(20.dp).clickable(onClick = onToggle),
        )
        // Tapping the amount/name also toggles — a bigger target, like the web row.
        Row(
            Modifier.weight(1f).clickable(onClick = onToggle),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = amount,
                modifier = Modifier.width(58.dp),
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
            )
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = name,
                    style = TextStyle(
                        fontSize = 15.sp,
                        textDecoration = if (checked) TextDecoration.LineThrough else null,
                    ),
                    color = WF.colors.ink,
                )
                if (sub != null) {
                    Text(
                        "↺ instead of ${ing.name}",
                        style = TextStyle(fontSize = 12.sp),
                        color = WF.colors.ink3,
                    )
                }
            }
        }
        Box(
            Modifier
                .size(30.dp)
                .background(
                    if (sub != null) WF.colors.ai.copy(alpha = 0.12f) else WF.colors.panel,
                    CircleShape,
                )
                .clip(CircleShape)
                .clickable(onClick = onSub),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.SwapHoriz,
                "Substitute ${ing.name}",
                tint = if (sub != null) WF.colors.ai else WF.colors.ink3,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

/** One quiet line: how many are on hand + what's missing, with a single add action. */
@Composable
private fun OnHandBannerRow(copy: OnHandBanner.Copy, onAdd: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card2, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(13.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(28.dp).background(WF.colors.ai, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                WaffledIcons.Sparkles,
                null,
                // White on a saturated coloured fill is the one case the rule allows.
                tint = androidx.compose.ui.graphics.Color.White,
                modifier = Modifier.size(13.dp),
            )
        }
        Row(Modifier.weight(1f)) {
            copy.lead?.let {
                Text(it, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black), color = WF.colors.ai)
            }
            Text(
                copy.tail,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                color = WF.colors.ink2,
            )
        }
        if (copy.showsAddButton) {
            Text(
                "Add to grocery",
                modifier = Modifier.clickable(onClick = onAdd),
                style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.Black),
                color = WF.colors.primaryD,
            )
        }
    }
}

@Composable
private fun MethodCard(
    steps: List<RecipeStepDTO>,
    noteFor: (Int) -> String?,
    onEditNote: (Int) -> Unit,
) {
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(
                "Method",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            for (step in steps) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                    Box(
                        Modifier.size(28.dp).background(WF.colors.panel, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "${step.stepNumber}",
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                            color = WF.colors.ink2,
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text(step.instruction, style = TextStyle(fontSize = 15.sp), color = WF.colors.ink)
                        if (step.ingredients.isNotEmpty() || (step.timerSeconds ?: 0) > 0) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                if (step.ingredients.isNotEmpty()) {
                                    Text(
                                        text = "Uses: ${step.ingredients.joinToString(", ")}",
                                        modifier = Modifier.weight(1f),
                                        style = TextStyle(fontSize = 12.5.sp),
                                        color = WF.colors.ink3,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                step.timerSeconds?.takeIf { it > 0 }?.let {
                                    Text(
                                        "⏱ ${CookTimer.mmss(it)}",
                                        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                        color = WF.colors.ink2,
                                    )
                                }
                            }
                        }
                        noteFor(step.stepNumber)?.let {
                            Text("📝 $it", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink2)
                        }
                        Text(
                            text = if (noteFor(step.stepNumber) == null) "＋ Add note" else "Edit note",
                            modifier = Modifier.clickable { onEditNote(step.stepNumber) },
                            style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ai,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NotesCard(
    notes: String?,
    draft: String,
    saved: String,
    onDraft: (String) -> Unit,
    onSave: () -> Unit,
) {
    var showSource by remember { mutableStateOf(false) }
    WaffledCard {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "📝 Your notes",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )
            WaffledTextField(
                value = draft,
                onValueChange = onDraft,
                placeholder = "e.g. doubles well · use less salt · the kids love this one…",
                singleLine = false,
                minHeight = 70.dp,
                modifier = Modifier.heightIn(min = 70.dp),
            )
            if (draft != saved) {
                WaffledPrimaryCTA("Save notes", onSave)
            }
            if (!notes.isNullOrEmpty()) {
                Text(
                    text = if (showSource) "Hide recipe notes" else "Recipe notes (from the source)",
                    modifier = Modifier.clickable { showSource = !showSource },
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink2,
                )
                if (showSource) {
                    Text(notes, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink2)
                }
            }
        }
    }
}
