package app.waffled.feature.planning.steps

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfChip
import app.waffled.feature.goals.GoalDisplay
import app.waffled.feature.goals.goalFmt
import app.waffled.feature.planning.PlanningStepProps
import app.waffled.feature.planning.api.PlanningKidCard
import app.waffled.feature.planning.api.PlanningKidFocusOption
import app.waffled.feature.planning.api.PlanningKidForwardOption
import app.waffled.feature.planning.api.PlanningKidPick
import app.waffled.feature.planning.api.PlanningKidsApi
import app.waffled.feature.planning.api.PlanningKidsChoice
import app.waffled.feature.planning.planningOptionChrome
import kotlinx.coroutines.launch

/**
 * Weekly Planning · step 9 "Kids" — port of iOS `KidsStepView`. Every card is up at once on
 * the kiosk; the phone shows one kid at a time behind a row of tabs. Both answers come from
 * things that already exist, "Something else" sits last, and once every card has both
 * answers the step becomes the read-back. It lends the banner no verb: it creates nothing.
 */
@Composable
fun KidsStepBody(props: PlanningStepProps) {
    val model = remember(props.env) { PlanningKidsStepModel(PlanningKidsApi(props.env.http)) }
    val state by model.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    LaunchedEffect(props.sessionId, props.weekStart) {
        model.load(props.sessionId, props.weekStart)
    }
    // After EVERY read and write, but never a null: a failed fetch's null is the wipe.
    LaunchedEffect(state.rev) { state.crumb?.let(props.setDecisionData) }
    LaunchedEffect(state.saving) { props.reportBusy(state.saving != null) }
    DisposableEffect(Unit) {
        props.lendVerb(null)
        onDispose {
            props.lendVerb(null)
            props.reportBusy(false)
        }
    }

    fun answer(personId: String, focus: PlanningKidPick = PlanningKidPick.Absent, forward: PlanningKidPick = PlanningKidPick.Absent) {
        if (state.isFrozen(props.busy)) return
        scope.launch {
            model.answer(props.sessionId, personId, props.weekStart, focus, forward)
            props.refresh()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            !state.loaded -> WaffledLoading()
            state.view == null -> WaffledEmptyState(
                emoji = "🧒",
                title = "Couldn’t read their week",
                message = "Reload, or skip this step — skipping is a real answer.",
                top = 24.dp,
            )
            state.kids.isEmpty() -> WaffledEmptyState(
                emoji = "🧒",
                title = "No cards to read out",
                message = "No one in this household is set up as a child yet. Add them in Settings → Family & People (member type “kid”) and this step will have something to ask. Skipping is a real answer in the meantime.",
                top = 24.dp,
            )
            else -> {
                Text(state.heading, style = WF.type.serif(20.sp, FontWeight.Bold), color = WF.colors.ink)
                val tabs = !props.env.isKiosk && state.kids.size > 1
                if (tabs) KidTabs(state, model::select)
                state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }

                val cards = if (tabs) listOfNotNull(state.activeCard) else state.kids
                cards.forEach { card ->
                    key(card.personId) { KidCard(card, state, model, props.busy, ::answer) }
                }

                if (state.isReadBack) {
                    GhostButton("Change something", disabled = false) { model.beginChanging() }
                } else if (state.canRepeat) {
                    GhostButton("Same as last week", disabled = state.isFrozen(props.busy)) {
                        scope.launch {
                            model.repeatLastWeek(props.sessionId, props.weekStart)
                            props.refresh()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun KidTabs(state: KidsStepState, onSelect: (String) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        state.kids.forEach { k ->
            val on = k.personId == state.activeCard?.personId
            Row(
                Modifier
                    .wfChip(selected = on)
                    .clickable { onSelect(k.personId) }
                    .semantics { selected = on }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(colorHex = k.colorHex, emoji = k.avatarEmoji ?: "🙂", size = 22.dp)
                Text(k.name, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = if (on) WF.colors.ink else WF.colors.ink2)
                if (k.settled) Text("★", style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = WF.colors.gold)
            }
        }
    }
}

@Composable
private fun KidCard(
    card: PlanningKidCard,
    state: KidsStepState,
    model: PlanningKidsStepModel,
    shellBusy: Boolean,
    answer: (String, PlanningKidPick, PlanningKidPick) -> Unit,
) {
    val frozen = state.isFrozen(shellBusy)
    WaffledCard(padding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CardHeader(card)
            TheirWeek(card)
            if (state.isReadBack) {
                ReadBack(card)
            } else {
                Question(card, KidsQuestion.Focus, "One thing to focus on", frozen, state.typing, model, answer) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        card.focusOptions.forEach { o ->
                            FocusOption(o, PlanningKidsChoice.focusChosen(card, o), frozen) {
                                answer(card.personId, PlanningKidPick.Key(o.key), PlanningKidPick.Absent)
                            }
                        }
                        FocusHatch(card, frozen) { model.beginTyping(card.personId, KidsQuestion.Focus) }
                    }
                }
                Question(card, KidsQuestion.Forward, "Something to look forward to", frozen, state.typing, model, answer) {
                    ChipFlow {
                        card.forwardOptions.forEach { o ->
                            ForwardOption(o, PlanningKidsChoice.forwardChosen(card, o), frozen) {
                                answer(card.personId, PlanningKidPick.Absent, PlanningKidPick.Key(o.key))
                            }
                        }
                        ForwardHatch(card, frozen) { model.beginTyping(card.personId, KidsQuestion.Forward) }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChipFlow(spacing: Int = 8, content: @Composable () -> Unit) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(spacing.dp),
        verticalArrangement = Arrangement.spacedBy(spacing.dp),
    ) { content() }
}

@Composable
private fun CardHeader(card: PlanningKidCard) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AvatarFromHex(colorHex = card.colorHex, emoji = card.avatarEmoji ?: "🙂", size = 40.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(card.name, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
            card.age?.let { Text("age $it", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3) }
        }
        // An economy that is off isn't drawn — never a zero, which reads as "earned nothing".
        card.stars?.let {
            WaffledStatusBadge(text = "${card.starsSymbol ?: "⭐"} $it", color = WF.colors.gold, size = 13.sp, weight = FontWeight.ExtraBold)
        }
    }
}

@Composable
private fun TheirWeek(card: PlanningKidCard) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        SectionLabel("Your week")
        if (card.week.isEmpty() && card.chores.isEmpty()) {
            Text("Nothing on it yet", style = TextStyle(fontSize = 13.sp), color = WF.colors.ink3)
        } else {
            ChipFlow(spacing = 6) {
                card.week.forEach { WeekChip(it.`when`, it.title, late = false) }
                card.chores.forEach { WeekChip(it.`when`, it.title, late = it.late) }
            }
        }
    }
}

@Composable
private fun WeekChip(whenLabel: String, title: String, late: Boolean) {
    Row(
        Modifier
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(if (late) WF.colors.warnT else WF.colors.panel)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(whenLabel, style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.ExtraBold), color = if (late) WF.colors.warn else WF.colors.ink3)
        Text(title, style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
    }
}

@Composable
private fun Question(
    card: PlanningKidCard,
    which: KidsQuestion,
    label: String,
    frozen: Boolean,
    typing: KidsTypeTarget?,
    model: PlanningKidsStepModel,
    answer: (String, PlanningKidPick, PlanningKidPick) -> Unit,
    options: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(label)
        options()
        if (typing == KidsTypeTarget(card.personId, which)) {
            // A new box per person AND per question, so switching kid never inherits words.
            key(card.personId, which) {
                KidTypeIn(
                    placeholder = if (which == KidsQuestion.Focus) "In their own words" else "Something on their week",
                    description = if (which == KidsQuestion.Focus) {
                        "Something else for ${card.name}"
                    } else {
                        "Something else for ${card.name} to look forward to"
                    },
                    initial = model.typeInSeed(card, which),
                    disabled = frozen,
                    onCancel = model::cancelTyping,
                    onSave = { text ->
                        if (which == KidsQuestion.Focus) {
                            answer(card.personId, PlanningKidPick.Text(text), PlanningKidPick.Absent)
                        } else {
                            answer(card.personId, PlanningKidPick.Absent, PlanningKidPick.Text(text))
                        }
                    },
                    onDraft = { model.recordDraft(card.personId, which, it) },
                )
            }
        }
    }
}

@Composable
private fun FocusOption(o: PlanningKidFocusOption, checked: Boolean, frozen: Boolean, onClick: () -> Unit) {
    val goal = o.goal
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (frozen) 0.6f else 1f)
            .planningOptionChrome(selected = checked)
            .clickable(enabled = !frozen, onClick = onClick)
            .semantics { selected = checked }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(o.emoji, style = TextStyle(fontSize = 20.sp), modifier = Modifier.width(26.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(o.label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
            o.detail?.let { Text(it, style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3) }
            if (o.routed) {
                Text("sent here in step 1", style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ai)
            }
        }
        if (goal != null) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(goalFmt(GoalDisplay.progress(goal)), style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
                GoalDisplay.target(goal)?.let {
                    Text("/ ${goalFmt(it)}", style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
                }
            }
        }
    }
}

@Composable
private fun FocusHatch(card: PlanningKidCard, frozen: Boolean, onClick: () -> Unit) {
    val chosen = PlanningKidsChoice.focusIsCustom(card)
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (frozen) 0.6f else 1f)
            .planningOptionChrome(selected = chosen)
            .clickable(enabled = !frozen, onClick = onClick)
            .semantics { selected = chosen }
            .padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (chosen) card.focus?.emoji ?: "✨" else "＋", style = TextStyle(fontSize = 18.sp), modifier = Modifier.width(26.dp))
        Text(
            if (chosen) card.focus?.label.orEmpty() else "Something else",
            style = TextStyle(fontSize = 15.sp, fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal),
            color = if (chosen) WF.colors.ink else WF.colors.ink3,
        )
    }
}

@Composable
private fun ForwardOption(o: PlanningKidForwardOption, checked: Boolean, frozen: Boolean, onClick: () -> Unit) {
    ForwardChip(o.emoji, "${o.`when`} · ${o.label}", checked, if (checked) WF.colors.ink else WF.colors.ink2, frozen, onClick)
}

@Composable
private fun ForwardHatch(card: PlanningKidCard, frozen: Boolean, onClick: () -> Unit) {
    val chosen = PlanningKidsChoice.forwardIsCustom(card)
    ForwardChip(
        emoji = if (chosen) card.forward?.emoji ?: "✨" else "＋",
        label = if (chosen) card.forward?.label.orEmpty() else "Add something",
        checked = chosen,
        color = if (chosen) WF.colors.ink else WF.colors.ink3,
        frozen = frozen,
        onClick = onClick,
    )
}

@Composable
private fun ForwardChip(emoji: String, label: String, checked: Boolean, color: androidx.compose.ui.graphics.Color, frozen: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .alpha(if (frozen) 0.6f else 1f)
            .wfChip(selected = checked)
            .clickable(enabled = !frozen, onClick = onClick)
            .semantics { selected = checked }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(emoji, style = TextStyle(fontSize = 14.sp))
        Text(label, style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold), color = color)
    }
}

@Composable
private fun ReadBack(card: PlanningKidCard) {
    Column(
        Modifier.semantics(mergeDescendants = true) { contentDescription = "What ${card.name} said" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        card.focus?.let { Said(it.emoji, it.label, "this week’s one thing") }
        card.forward?.let {
            Said(it.emoji, it.label, if (it.`when`.isEmpty()) "the bit to look forward to" else "${it.`when`} — the bit to look forward to")
        }
    }
}

@Composable
private fun Said(emoji: String, big: String, caption: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(emoji, style = TextStyle(fontSize = 30.sp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(big, style = WF.type.serif(20.sp, FontWeight.Bold), color = WF.colors.ink)
            Text(caption, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink3)
        }
    }
}

/**
 * The escape hatch's box. [initial] is their saved answer or their unsaved draft; [onDraft]
 * fires once as the box goes away rather than per keystroke.
 */
@Composable
private fun KidTypeIn(
    placeholder: String,
    description: String,
    initial: String,
    disabled: Boolean,
    onCancel: () -> Unit,
    onSave: (String) -> Unit,
    onDraft: (String) -> Unit,
) {
    var text by remember { mutableStateOf(initial) }
    val focus = remember { FocusRequester() }
    val trimmed = text.trim()
    val save = { if (!disabled && trimmed.isNotEmpty()) onSave(trimmed) }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    // Read through a ref so the dispose sees the latest words, not the first composition's.
    val latest = remember { arrayOf(initial) }
    latest[0] = text
    DisposableEffect(Unit) { onDispose { onDraft(latest[0]) } }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        WaffledTextField(
            value = text,
            onValueChange = { text = it.take(MAX_TYPE_IN) },
            placeholder = placeholder,
            modifier = Modifier
                .focusRequester(focus)
                .semantics { contentDescription = description },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { save() }),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Cancel",
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(WF.radius.md))
                    .background(WF.colors.panel)
                    .clickable(onClick = onCancel)
                    .padding(vertical = 14.dp),
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
                color = WF.colors.ink2,
            )
            WaffledPrimaryCTA(label = "Save", onClick = save, modifier = Modifier.weight(1f), isDisabled = disabled || trimmed.isEmpty())
        }
    }
}

private const val MAX_TYPE_IN = 120

/** The quiet panel capsule iOS uses for a step's own control; no shared equivalent exists. */
@Composable
private fun GhostButton(label: String, disabled: Boolean, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .alpha(if (disabled) 0.6f else 1f)
            .clip(RoundedCornerShape(WF.radius.pill))
            .background(WF.colors.panel)
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.ink2,
    )
}
