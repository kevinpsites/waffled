package app.waffled.feature.planning

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledLoading
import app.waffled.core.design.WaffledMenuPill
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.wfField
import app.waffled.core.model.WaffledModule
import app.waffled.feature.planning.api.PlanningStep
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Weekly Planning — the session shell: the lobby, "Left for now", the agenda sheet, the
 * saved record and the in-session chrome. Every step's BODY lives in its own file behind
 * [PlanningStepBody]; the catalog comes from the server so this screen and the web can't
 * drift. Port of iOS `PlanningShellView`.
 *
 * [onBack] pops the screen and leaves the session current (re-opening resumes it); "Leave
 * for now" is the separate control that parks it. [refreshKey] re-reads the view when it
 * changes.
 *
 * Two clearances, as on iOS: [bottomClearance] for screens that SCROLL under the tab bar,
 * and [footerClearance] for the session footer PINNED flush on top of it — the bar's own
 * height (64dp; the navigation-bar inset is added here). Pass 0.dp for both on the kiosk,
 * which has no bar. The footer drops its clearance while the keyboard is up.
 */
@Composable
fun PlanningShell(
    env: PlanningEnvironment,
    /** Null at a tablet rail root, where there is nowhere to go back to. */
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    refreshKey: Any? = Unit,
    bottomClearance: Dp = WF.spacing.tabBarClearance,
    footerClearance: Dp = 64.dp,
) {
    val model = remember(env) { env.newModel() }
    val state by model.state.collectAsStateWithLifecycle()
    val modules by env.sync.modules.collectAsStateWithLifecycle()
    LaunchedEffect(model, refreshKey) { model.load() }

    // ONE scope for every model write, owned by the shell. A write often flips the screen
    // it was launched from (discard leaves "Left for now", reopen leaves the record, a
    // jump closes the agenda); a sub-screen's own scope would be cancelled with it,
    // dropping the request or the reload. Do not push scopes back down into the screens.
    val scope = rememberCoroutineScope()
    val ui = remember(scope) { ShellUi(scope) }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        when {
            !modules.isOn(WaffledModule.WeeklyPlanning) -> WaffledEmptyState(
                emoji = "🗓️",
                title = "Weekly Planning is off",
                message = "Turn it on in Settings → Modules to run a guided session for the week ahead.",
            )
            state.view == null -> if (state.loaded) {
                WaffledEmptyState(
                    emoji = "😕",
                    title = "Couldn’t load the session",
                    message = "Pull to refresh, or check that you’re still signed in.",
                )
            } else {
                WaffledLoading()
            }
            state.hasNoRunnableSteps -> WaffledEmptyState(
                emoji = "🧩",
                title = "Nothing to run",
                message = "Every step of the session reads a module that’s turned off. Turn one back on in Settings → Modules, or turn individual steps on under Weekly Planning.",
            )
            state.showsRecord -> WithBackRow(onBack, env.isKiosk) { RecordScreen(model, state, ui, env, bottomClearance) }
            state.isPaused -> WithBackRow(onBack, env.isKiosk) { PausedScreen(model, state, ui, bottomClearance) }
            state.session == null -> WithBackRow(onBack, env.isKiosk) { LobbyScreen(model, state, ui, bottomClearance) }
            else -> SessionScreen(model, state, ui, env, onBack, footerClearance)
        }
    }

    if (ui.agenda) AgendaSheet(model, state, ui)
    if (ui.parking) {
        PlanningParkNoteSheet(
            tags = state.parkTags,
            errorMessage = state.parkError,
            onPark = { note, stepKey -> model.parkNote(note, stepKey) },
            onClose = {
                ui.parking = false
                model.clearParkError()
            },
        )
    }
    if (ui.parkingBetween) {
        PlanningParkNoteSheet(
            tags = emptyList(),
            betweenSessions = true,
            errorMessage = state.parkError,
            onPark = { note, _ -> model.parkBetweenSessions(note) },
            onClose = {
                ui.parkingBetween = false
                model.clearParkError()
            },
        )
    }
}

/** Screen-local UI state — the iOS view's `@State` fields — and the shell's write scope. */
private class ShellUi(val scope: CoroutineScope) {
    var agenda by mutableStateOf(false)
    var parking by mutableStateOf(false)
    var parkingBetween by mutableStateOf(false)
    var confirmDiscard by mutableStateOf(false)

    /**
     * The verb the step on screen lent the banner, PAIRED with the step that lent it, so a
     * verb whose owner is off screen is simply not read — never cleared by an effect, which
     * would race the step's own effect.
     */
    var handoffVerb by mutableStateOf<PlanningHandoffVerb?>(null)
    var handoffVerbStepKey by mutableStateOf<String?>(null)

    /** A write the STEP owns is in flight; the footer goes cold. */
    var stepBusy by mutableStateOf(false)
}

/**
 * The back chevron above the lobby, "left for now" and the record. The session header draws
 * its own; the others have no header, so without this the phone leans on the system Back.
 */
@Composable
private fun WithBackRow(onBack: (() -> Unit)?, isKiosk: Boolean, content: @Composable () -> Unit) {
    if (onBack == null || isKiosk) {
        content()
        return
    }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.padding(start = 16.dp, top = 6.dp)) { BackChevron(onBack) }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}

@Composable
private fun BackChevron(onBack: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(WF.colors.panel)
            .clickable(onClick = onBack)
            .semantics { contentDescription = "Back" },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, null, tint = WF.colors.ink2, modifier = Modifier.size(20.dp))
    }
}

// ---- lobby (no session yet) ----

@Composable
private fun LobbyScreen(model: PlanningModel, state: PlanningState, ui: ShellUi, bottomClearance: Dp) {
    val scope = ui.scope
    ScrollColumn(bottomClearance) {
        ErrorBanner(model, state)
        Text("${state.sessionDayName}’s session", style = WF.type.serif(26.sp, FontWeight.Bold), color = WF.colors.ink)
        Text(
            "${state.runnable.size} steps. Jump anywhere, leave whenever the week is decided.",
            style = TextStyle(fontSize = 14.sp),
            color = WF.colors.ink3,
        )
        WeekStepper(model, state, ui)
        Column(Modifier.padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.actGroups.forEach { group ->
                key(group.id) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        SectionLabel(group.act)
                        Text(
                            group.steps.joinToString(" · ") { it.title },
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink2,
                        )
                    }
                }
            }
        }
        WaffledPrimaryCTA(
            label = "Start the session",
            onClick = { scope.launch { model.start() } },
            isBusy = state.busy,
            modifier = Modifier.padding(top = 4.dp),
        )
        ParkBetweenButton(state, ui)
    }
}

// ---- left for now ----

@Composable
private fun PausedScreen(model: PlanningModel, state: PlanningState, ui: ShellUi, bottomClearance: Dp) {
    ScrollColumn(bottomClearance) {
        ErrorBanner(model, state)
        Text("Left for now", style = WF.type.serif(26.sp, FontWeight.Bold), color = WF.colors.ink)
        Text(
            "${state.weekLabel} is part-planned — ${state.settledCount} of ${state.runnable.size} steps decided. Nothing was lost; pick it up whenever.",
            style = TextStyle(fontSize = 14.sp),
            color = WF.colors.ink3,
        )
        WaffledPrimaryCTA(label = "Resume the session", onClick = { model.resume() }, isBusy = state.busy)
        ParkBetweenButton(state, ui)
        PlanAnotherWeek(model, state, ui)
        DiscardBlock(model, state, ui)
    }
}

// ---- the record ----

@Composable
private fun RecordScreen(
    model: PlanningModel,
    state: PlanningState,
    ui: ShellUi,
    env: PlanningEnvironment,
    bottomClearance: Dp,
) {
    val scope = ui.scope
    ScrollColumn(bottomClearance) {
        ErrorBanner(model, state)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("The week is decided", style = WF.type.serif(26.sp, FontWeight.Bold), color = WF.colors.ink)
            Text(
                state.savedAtLabel?.let { "${state.weekLabel} · saved $it" } ?: state.weekLabel,
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink3,
            )
        }
        PlanAnotherWeek(model, state, ui)
        // The recap body already reads the week back, so the record renders it rather than
        // a second summary — through the seam, so a renamed body can't leave this behind.
        val recap = state.steps.firstOrNull { it.key == PlanningStepKeys.RECAP }
        val sessionId = state.session?.id
        val week = state.view?.weekStart
        if (recap != null && sessionId != null && week != null) {
            key("record-recap", state.parkedBetweenRevision) {
                PlanningStepBody(stepProps(recap, sessionId, week, model, state, ui, env, scope))
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("What each step decided")
                WaffledCard(padding = 4.dp) {
                    if (state.decidedSteps.isEmpty()) {
                        Text(
                            "Nothing was decided in this session.",
                            modifier = Modifier.padding(horizontal = 11.dp, vertical = 14.dp),
                            style = TextStyle(fontSize = 14.sp),
                            color = WF.colors.ink3,
                        )
                    } else {
                        state.decidedSteps.forEachIndexed { i, step ->
                            if (i > 0) HorizontalDivider(color = WF.colors.hair)
                            RecordRow(step)
                        }
                    }
                }
            }
        }
        ParkBetweenButton(state, ui)
        QuietWideButton("Reopen the session", enabled = !state.busy && !ui.stepBusy) {
            scope.launch { model.reopen() }
        }
        DiscardBlock(model, state, ui)
    }
}

@Composable
private fun RecordRow(step: PlanningStep) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 11.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Text(
            if (step.isDone) "✓" else "–",
            modifier = Modifier.width(22.dp),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.ExtraBold),
            color = if (step.isDone) WF.colors.success else WF.colors.ink3,
            textAlign = TextAlign.Center,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(step.title, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
            Text(
                if (step.isDone) step.primary else "Skipped — a real answer",
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink3,
            )
        }
    }
}

// ---- in session ----

@Composable
private fun SessionScreen(
    model: PlanningModel,
    state: PlanningState,
    ui: ShellUi,
    env: PlanningEnvironment,
    onBack: (() -> Unit)?,
    footerClearance: Dp,
) {
    val scope = ui.scope
    val step = state.current
    val sessionId = state.session?.id
    val week = state.view?.weekStart
    val props = if (step != null && sessionId != null && week != null) {
        stepProps(step, sessionId, week, model, state, ui, env, scope)
    } else {
        null
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        SessionHeader(model, state, ui, env.isKiosk, onBack)
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            ErrorBanner(model, state)
            if (props != null) {
                // Per-note hidden state is local to the banner: a step change clears it.
                key(props.step.key) {
                    PlanningHandoffBanner(
                        step = props.step,
                        routes = props.routes,
                        busy = state.busy,
                        // A verb belongs to the step that lent it.
                        verb = if (ui.handoffVerbStepKey == props.step.key) ui.handoffVerb else null,
                        resolve = { id, action -> model.resolveParked(id, action) },
                        update = { id, note, tag ->
                            try {
                                env.api.updateParkedNote(id, note, tag)
                                null
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                PlanningModel.errorText(e, PlanningHandoffCopy.WRITE_FAILED)
                            }
                        },
                        steps = state.steps,
                    )
                }
                // Keyed on the step AND the week, so week B never inherits week A's answers.
                key(props.step.key, props.weekStart) { PlanningStepBody(props) }
            }
        }
        SessionFooter(model, state, ui, props, env.isKiosk, footerClearance)
    }
}

@Composable
private fun SessionHeader(model: PlanningModel, state: PlanningState, ui: ShellUi, isKiosk: Boolean, onBack: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!isKiosk && onBack != null) BackChevron(onBack)
                Text(
                    state.current?.title.orEmpty(),
                    modifier = Modifier.weight(1f),
                    style = WF.type.serif(22.sp, FontWeight.Bold),
                    color = WF.colors.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    state.weekLabel,
                    style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                    color = WF.colors.ink3,
                    maxLines = 1,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                WaffledMenuPill(
                    text = "${state.position} of ${state.runnable.size}",
                    modifier = Modifier
                        .clip(RoundedCornerShape(WF.radius.pill))
                        .clickable { ui.agenda = true }
                        .semantics {
                            contentDescription = "Step ${state.position} of ${state.runnable.size}. Open the agenda"
                        },
                )
                Spacer(Modifier.weight(1f))
                // A SEPARATE control from the back chevron: back leaves the session current,
                // this parks it.
                Text(
                    "Leave for now",
                    modifier = Modifier.clickable { model.leave() },
                    style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
                    color = WF.colors.ink3,
                )
            }
            Text(state.current?.ask.orEmpty(), style = TextStyle(fontSize = 13.5.sp), color = WF.colors.ink2)
        }
        PlanningProgressBar(value = state.progress)
    }
}

@Composable
private fun SessionFooter(
    model: PlanningModel,
    state: PlanningState,
    ui: ShellUi,
    props: PlanningStepProps?,
    isKiosk: Boolean,
    footerClearance: Dp,
) {
    val scope = ui.scope
    val cold = state.busy || ui.stepBusy
    Column(Modifier.fillMaxWidth().background(WF.colors.card)) {
        HorizontalDivider(color = WF.colors.hair)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 10.dp + footerInset(footerClearance)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "Skip this step",
                modifier = Modifier.clickable(enabled = !cold) { scope.launch { model.answer("skipped") } },
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink3,
            )
            if (state.showsParkBar) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .clickable(enabled = !cold) { ui.parking = true }
                        .semantics { contentDescription = "Park a note" },
                    contentAlignment = Alignment.Center,
                ) {
                    Text("📌", style = TextStyle(fontSize = 15.sp))
                }
            }
            if (props != null) PlanningStepFooterExtra(props)
            Spacer(Modifier.weight(1f))
            PrimaryAnswerButton(state, cold, isKiosk) { scope.launch { model.answer("done") } }
        }
    }
}

/**
 * Hand-rolled rather than [WaffledPrimaryCTA]: that fills the width with one label, and this
 * sits beside Skip with an optional kiosk-only "· next" hint.
 */
@Composable
private fun PrimaryAnswerButton(state: PlanningState, cold: Boolean, isKiosk: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .clip(shape)
            .background(if (cold) WF.colors.ink3 else WF.colors.primary, shape)
            .clickable(enabled = !cold, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (cold) CircularProgressIndicator(Modifier.size(14.dp), color = Color.White, strokeWidth = 2.dp)
        Text(
            state.current?.primary ?: "Done",
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = Color.White,
            maxLines = 1,
        )
        val next = state.next
        if (isKiosk && next != null) {
            Text(
                "· next: ${next.title}",
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                color = Color.White.copy(alpha = 0.75f),
                maxLines = 1,
            )
        }
    }
}

// ---- the agenda sheet ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgendaSheet(model: PlanningModel, state: PlanningState, ui: ShellUi) {
    val scope = ui.scope
    val close = {
        ui.agenda = false
        ui.confirmDiscard = false
    }
    ModalBottomSheet(
        onDismissRequest = close,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
            Text(
                "Close",
                modifier = Modifier.align(Alignment.CenterStart).clickable(onClick = close),
                style = TextStyle(fontSize = 16.sp),
                color = WF.colors.primary,
            )
            Text("The agenda", style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
        }
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("${state.sessionDayName}’s session", style = WF.type.serif(22.sp, FontWeight.Bold), color = WF.colors.ink)
                Text(
                    "${state.runnable.size} steps. Jump anywhere, leave whenever the week is decided.",
                    style = TextStyle(fontSize = 13.sp),
                    color = WF.colors.ink3,
                )
            }
            WeekStepper(model, state, ui)
            state.actGroups.forEach { group ->
                key(group.id) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionLabel(group.act)
                        group.steps.forEach { step ->
                            AgendaRow(step, state, enabled = !state.busy && !ui.stepBusy) {
                                ui.agenda = false
                                scope.launch { model.jump(step.key) }
                            }
                        }
                    }
                }
            }
            QuietWideButton("Leave for now") {
                ui.agenda = false
                model.leave()
            }
            DiscardBlock(model, state, ui)
        }
    }
}

@Composable
private fun AgendaRow(step: PlanningStep, state: PlanningState, enabled: Boolean, onClick: () -> Unit) {
    val here = step.key == state.current?.key
    Row(
        Modifier
            .fillMaxWidth()
            .wfField(radius = WF.radius.sm, fill = if (here) WF.colors.primary.copy(alpha = 0.06f) else WF.colors.card)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Box(
            Modifier
                .size(24.dp)
                .background(if (here) WF.colors.primary.copy(alpha = 0.12f) else WF.colors.panel, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (step.isDone) "✓" else "${state.stepNumbers[step.key] ?: 0}",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.ExtraBold),
                color = when {
                    step.isDone -> WF.colors.success
                    here -> WF.colors.primary
                    else -> WF.colors.ink3
                },
            )
        }
        Text(
            step.title,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 15.sp, fontWeight = if (here) FontWeight.ExtraBold else FontWeight.SemiBold),
            color = if (step.isSettled && !here) WF.colors.ink2 else WF.colors.ink,
        )
        when {
            here -> WaffledStatusBadge("you’re here", WF.colors.primary)
            step.isDone -> WaffledStatusBadge("decided", WF.colors.success)
            step.isSkipped -> WaffledStatusBadge("skipped", WF.colors.ink3)
        }
    }
}

// ---- shared bits ----

/** The week stepper. The back arrow floors at the household's current week. */
@Composable
private fun WeekStepper(model: PlanningModel, state: PlanningState, ui: ShellUi) {
    val scope = ui.scope
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StepperArrow(
            icon = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
            label = "Plan the previous week",
            enabled = state.canGoBack && !state.busy,
            dimmed = !state.canGoBack,
        ) { scope.launch { model.goPreviousWeek() } }
        Text(
            state.weekLabel,
            modifier = Modifier.weight(1f),
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
            textAlign = TextAlign.Center,
        )
        StepperArrow(
            icon = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            label = "Plan the next week",
            enabled = !state.busy && !ui.stepBusy,
            dimmed = false,
        ) { scope.launch { model.goNextWeek() } }
    }
}

@Composable
private fun StepperArrow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    enabled: Boolean,
    dimmed: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(WF.colors.panel)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = if (dimmed) WF.colors.ink3.copy(alpha = 0.4f) else WF.colors.ink2, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun PlanAnotherWeek(model: PlanningModel, state: PlanningState, ui: ShellUi) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel("Plan another week")
        WeekStepper(model, state, ui)
    }
}

/**
 * Start the week over. The lobby is otherwise unreachable once a session exists, so a week
 * started by mistake could never be undone. Two taps: there is no undo.
 */
@Composable
private fun DiscardBlock(model: PlanningModel, state: PlanningState, ui: ShellUi) {
    val scope = ui.scope
    if (ui.confirmDiscard) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(WF.colors.dangerT, RoundedCornerShape(WF.radius.md))
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "Throw this session away and start the week over? What it already decided — events added, chores handed out — stays put; only the session is discarded.",
                style = TextStyle(fontSize = 12.5.sp),
                color = WF.colors.ink2,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CapsuleButton("Keep it", WF.colors.panel, WF.colors.ink2, Modifier.weight(1f), enabled = true) {
                    ui.confirmDiscard = false
                }
                CapsuleButton(
                    "Start over",
                    WF.colors.danger,
                    Color.White,
                    Modifier.weight(1f),
                    enabled = !state.busy && !ui.stepBusy,
                ) {
                    ui.confirmDiscard = false
                    ui.agenda = false
                    scope.launch { model.discard() }
                }
            }
        }
    } else if (state.session != null) {
        Text(
            "Start this week over",
            modifier = Modifier
                .padding(top = 2.dp)
                .clickable { ui.confirmDiscard = true },
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.danger,
        )
    }
}

@Composable
private fun CapsuleButton(label: String, fill: Color, ink: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier
            .clip(shape)
            .background(fill, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = ink)
    }
}

/** The record's / agenda's quiet full-width action on `wfField` chrome. */
@Composable
private fun QuietWideButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .wfField()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink2)
    }
}

/** The record, "Left for now" and the lobby are when a note for the NEXT session comes up. */
@Composable
private fun ParkBetweenButton(state: PlanningState, ui: ShellUi) {
    QuietWideButton("📌  Park a note", enabled = !state.busy) { ui.parkingBetween = true }
}

@Composable
private fun ErrorBanner(model: PlanningModel, state: PlanningState) {
    state.errorMessage?.let { DismissibleErrorBanner(message = it, onDismiss = model::dismissError) }
}

/** The pinned footer's clearance: the bar plus the nav-bar inset, none while typing. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun footerInset(footerClearance: Dp): Dp {
    if (footerClearance == 0.dp || WindowInsets.isImeVisible) return 0.dp
    return footerClearance + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
}

@Composable
private fun ScrollColumn(bottomClearance: Dp, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
            .padding(bottom = bottomClearance),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        content = content,
    )
}

private fun stepProps(
    step: PlanningStep,
    sessionId: String,
    weekStart: String,
    model: PlanningModel,
    state: PlanningState,
    ui: ShellUi,
    env: PlanningEnvironment,
    scope: CoroutineScope,
): PlanningStepProps = PlanningStepProps(
    step = step,
    sessionId = sessionId,
    weekStart = weekStart,
    env = env,
    setDecisionData = model::setDecisionData,
    refresh = { scope.launch { model.load() } },
    busy = state.busy,
    // Off the looseEnds step's OWN row; a step that hasn't run has no `routes` key.
    routes = PlanningRouteSeed.decode(state.steps.firstOrNull { it.key == PlanningStepKeys.LOOSE_ENDS }?.data?.get("routes")),
    goToStep = model::show,
    lendVerb = { verb ->
        ui.handoffVerb = verb
        ui.handoffVerbStepKey = if (verb == null) null else step.key
    },
    reportBusy = { ui.stepBusy = it },
)
