package app.waffled.feature.recipes

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledTextField
import app.waffled.core.design.wfShadow1
import app.waffled.core.design.wfShadow3
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Full-screen, step-by-step Cook Mode — the phone layout of iOS `CookModeView`.
 *
 * Big type for across-the-kitchen reading, a progress bar, the step's ingredients, and a
 * finish button that marks the dish cooked. On a plate, a tab strip across its dishes,
 * each keeping its own place.
 *
 * Three things this screen owes the platform, all of which fail quietly if skipped:
 *
 *  1. **The screen stays awake.** iOS sets `isIdleTimerDisabled`; here it is
 *     `View.keepScreenOn`, in a [DisposableEffect] so it is released on the way out. No
 *     Activity cast, no new dependency.
 *  2. **Timers are wall-clock, not coroutines.** The ticker below only *reads* — it never
 *     owns the countdown. Every timer is an absolute instant persisted by
 *     [CookSessionStore], so a backgrounded (or killed) app comes back correct. The
 *     lifecycle observer re-ticks on resume because a timer can come due while away.
 *  3. **Leaving the screen does NOT cancel pending alerts.** This composable is torn down
 *     when the app is backgrounded too, and cancelling then would kill the very
 *     notification meant to reach the cook while they are away. Alerts are cancelled only
 *     on explicit action: pause, dismiss, or ✕.
 *
 * **Scope:** phone layout only. The iPad/kiosk split (ingredients in a fixed left sidebar,
 * 56pt instruction type) is not ported.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CookModeScreen(
    store: CookSessionStore,
    modifier: Modifier = Modifier,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val session = state.session ?: return
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var showOverview by remember { mutableStateOf(false) }
    /** Bumped once a second purely to re-read the clock; the timers own their own truth. */
    var tickNow by remember { mutableLongStateOf(System.currentTimeMillis()) }

    val steps = session.steps
    val step = steps.getOrNull(session.index)
    val isLast = session.index >= steps.size - 1
    val firing = state.timers.firstOrNull { it.firing }
    val dockTimers = state.timers.filterNot { it.firing }

    KeepScreenOn()
    RequestNotificationPermissionOnce()

    // One ticker drives every timer's countdown display and the fire detection. A whole
    // second of drift is invisible on a kitchen timer, and the value is recomputed from
    // the wall clock, so this never accumulates error.
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            store.tick()
            tickNow = System.currentTimeMillis()
        }
    }

    // A timer can hit zero while the app is backgrounded — re-evaluate on return.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                store.tick()
                tickNow = System.currentTimeMillis()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Box(modifier.fillMaxSize().background(WF.colors.canvas)) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            CookTopBar(
                title = store.title,
                onClose = { store.end() },
                onOverview = { showOverview = true },
            )

            // The plate's dishes as a tab strip — only when there's more than one, since a
            // lone tab is noise. Each tab badges that dish's running timers, so a side
            // simmering on another tab still says so.
            if (session.dishes.size > 1) {
                Row(
                    Modifier
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (dish in session.dishes) {
                        DishTab(
                            title = dish.title,
                            running = store.dishTimers(dish.id).size,
                            isOn = dish.id == session.activeDishId,
                            onClick = { store.switchToDish(dish.id) },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
            }

            ReturnPill(
                mark = session.pendingReturn,
                title = session.pendingReturnTitle,
                onBack = { store.goBack() },
                onDismiss = { store.dismissReturn() },
            )

            LinearProgressIndicator(
                progress = { if (steps.isEmpty()) 0f else (session.index + 1f) / steps.size },
                color = WF.colors.primary,
                trackColor = WF.colors.panel,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
            )

            // The step column scrolls so a long instruction is never clipped, and leaves
            // room for the floating dock.
            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 28.dp, vertical = 24.dp)
                    .padding(bottom = if (dockTimers.isEmpty()) 0.dp else 96.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Text(
                    text = "STEP ${step?.stepNumber ?: (session.index + 1)} OF ${steps.size}",
                    style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Black, letterSpacing = 1.4.sp),
                    color = WF.colors.success,
                )
                Text(
                    text = step?.instruction.orEmpty(),
                    style = WF.type.serif(38.sp, FontWeight.SemiBold),
                    color = WF.colors.ink,
                )

                val secs = step?.timerSeconds ?: 0
                if (secs > 0) {
                    StartTimerButton(secs) {
                        store.startTimer(secs, session.index, step?.stepNumber ?: (session.index + 1))
                    }
                } else {
                    // The step has no built-in timer — let the cook add one on the fly,
                    // tied to this step through the same runtime path. Keyed on the index
                    // so the control resets when navigating steps.
                    key(session.index) {
                        AddTimerControl { chosen ->
                            store.startTimer(chosen, session.index, step?.stepNumber ?: (session.index + 1))
                        }
                    }
                }

                val stepIngredients = step?.ingredients.orEmpty()
                if (stepIngredients.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        for (ig in stepIngredients) {
                            val tickKey = CookSession.ingredientKey(ig, session.ingredients)
                            val on = session.isTicked(tickKey)
                            Row(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(WF.radius.pill))
                                    .background(WF.colors.success.copy(alpha = if (on) 0.05f else 0.12f))
                                    .toggleable(value = on, role = Role.Checkbox) { store.toggleTick(tickKey) }
                                    .padding(horizontal = 12.dp, vertical = 7.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                TickBox(on)
                                Text(
                                    text = CookSession.chipLabel(ig, session.ingredients),
                                    style = TextStyle(
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Medium,
                                        textDecoration = if (on) TextDecoration.LineThrough else null,
                                    ),
                                    color = WF.colors.success,
                                )
                            }
                        }
                    }
                }

                step?.note?.let { note ->
                    Text(
                        text = "📝 $note",
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
                            .padding(14.dp),
                        style = TextStyle(fontSize = 16.sp),
                        color = WF.colors.ink2,
                    )
                }
            }

            CookNavBar(
                canGoBack = session.index > 0,
                isLast = isLast,
                onBack = { store.index = session.index - 1 },
                onNext = { store.index = session.index + 1 },
                onFinish = { scope.launch { store.finish() } },
            )
        }

        // Pinned bottom-right and width-capped so it occupies one side rather than
        // spanning the screen.
        if (dockTimers.isNotEmpty() && firing == null) {
            Column(
                Modifier
                    .align(Alignment.BottomEnd)
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 92.dp)
                    .widthIn(max = 360.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (t in dockTimers) {
                    TimerDockRow(
                        timer = t,
                        now = tickNow,
                        onJump = { store.jump(t) },
                        onTogglePause = {
                            if (t.running) store.pauseTimer(t) else store.resumeTimer(t)
                        },
                        onDismiss = { store.removeTimer(t) },
                    )
                }
            }
        }

        firing?.let { t ->
            AlarmOverlay(
                timer = t,
                onJump = {
                    store.jump(t)
                    store.removeTimer(t)
                },
                onAddMinute = { store.addMinute(t) },
                onDismiss = { store.removeTimer(t) },
            )
        }
    }

    if (showOverview) {
        ModalBottomSheet(
            onDismissRequest = { showOverview = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = WF.colors.canvas,
        ) {
            CookOverviewSheet(
                title = session.activeDish?.title ?: store.title,
                steps = steps,
                ingredients = session.ingredients,
                currentIndex = session.index,
                isTicked = session::isTicked,
                tickedCount = session.tickedCount,
                onToggleTick = store::toggleTick,
                onPickStep = {
                    store.index = it
                    showOverview = false
                },
            )
        }
    }
}

/**
 * Hold the display awake while cooking — the Android twin of iOS's `isIdleTimerDisabled`.
 *
 * `View.keepScreenOn` rather than a window flag, so no Activity cast is needed from a
 * feature module. `DisposableEffect` releases it, including on a backgrounded teardown.
 */
@Composable
private fun KeepScreenOn() {
    val view = LocalView.current
    DisposableEffect(view) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }
}

/**
 * Ask for `POST_NOTIFICATIONS` the first time Cook Mode opens on API 33+.
 *
 * Denied, everything else still works — the alarm fires and the in-app overlay rings; the
 * OS simply drops the out-of-app post. So this asks once and never blocks.
 */
@Composable
private fun RequestNotificationPermissionOnce() {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* Granted or not, Cook Mode carries on. */ }

    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission(context)) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

private fun hasNotificationPermission(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

@Composable
private fun CookTopBar(title: String, onClose: () -> Unit, onOverview: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = "Leave cook mode",
            tint = WF.colors.ink2,
            modifier = Modifier.size(20.dp).clickable(onClick = onClose),
        )
        Text(
            text = title,
            modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = WF.colors.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Icon(
            imageVector = Icons.AutoMirrored.Filled.FormatListBulleted,
            contentDescription = "The whole recipe",
            tint = WF.colors.ink2,
            modifier = Modifier.size(20.dp).clickable(onClick = onOverview),
        )
    }
}

@Composable
private fun DishTab(title: String, running: Int, isOn: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .background(if (isOn) WF.colors.ink else WF.colors.panel, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
            // `onInk`, never white: `ink` flips to a warm off-white in dark mode.
            color = if (isOn) WF.colors.onInk else WF.colors.ink2,
            maxLines = 1,
        )
        if (running > 0) {
            Icon(
                imageVector = Icons.Filled.Timer,
                contentDescription = null,
                tint = if (isOn) WF.colors.onInk else WF.colors.primaryD,
                modifier = Modifier.size(12.dp),
            )
            Text(
                text = "$running",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black),
                color = if (isOn) WF.colors.onInk else WF.colors.primaryD,
            )
        }
    }
}

/**
 * "Back to step 6 · Chicken" — where a fired timer pulled you off.
 *
 * Step FIRST, dish second: recipe titles run long, and when the title led it ate the pill
 * and pushed the step number — the part you actually need — off the end.
 */
@Composable
private fun ReturnPill(
    mark: CookSession.Mark?,
    title: String?,
    onBack: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (mark == null || title == null) return
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .padding(horizontal = 20.dp, vertical = 4.dp)
            .fillMaxWidth()
            .background(WF.colors.panel, shape)
            .clip(shape)
            .padding(start = 14.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).clickable(onClick = onBack).padding(vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.Undo,
                contentDescription = null,
                tint = WF.colors.ink,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = "Back to step ${mark.step + 1}",
                style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
                maxLines = 1,
            )
            Text(
                text = "· $title",
                style = TextStyle(fontSize = 14.sp),
                color = WF.colors.ink2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = "Dismiss",
            tint = WF.colors.ink3,
            modifier = Modifier.size(24.dp).clickable(onClick = onDismiss).padding(6.dp),
        )
    }
}

@Composable
private fun StartTimerButton(secs: Int, onStart: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    Row(
        Modifier
            .background(WF.colors.primary, shape)
            .clip(shape)
            .clickable(onClick = onStart)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Timer, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(16.dp))
        Text(
            text = "Start ${CookTimer.mmss(secs)}",
            style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
            // White is correct on a saturated coloured fill — the one case the `onInk`
            // rule allows it.
            color = androidx.compose.ui.graphics.Color.White,
        )
    }
}

/**
 * On-the-spot timer for a step the author never gave one.
 *
 * Collapsed to a dashed "⏱ Add timer" pill; expands to minute + second fields and starts
 * a runtime-only timer through the same store path, so it lives in the dock, rings, and
 * stays tied to its step. Nothing is persisted to the step.
 *
 * iOS uses two wheel pickers. Compose has no wheel picker and `core:design` has no number
 * control, so this is [WaffledTextField] in number mode — reusing the shared field rather
 * than hand-rolling a stepper that would take forever to reach 45 seconds.
 */
@Composable
private fun AddTimerControl(onStart: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var minutes by remember { mutableStateOf("") }
    var seconds by remember { mutableStateOf("") }
    val total = (minutes.toIntOrNull() ?: 0) * 60 + (seconds.toIntOrNull() ?: 0).coerceIn(0, 59)

    if (!open) {
        val shape = RoundedCornerShape(WF.radius.pill)
        Row(
            Modifier
                .border(2.dp, WF.colors.primary.copy(alpha = 0.6f), shape)
                .clip(shape)
                .clickable { open = true }
                .padding(horizontal = 18.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Timer, null, tint = WF.colors.primaryD, modifier = Modifier.size(16.dp))
            Text(
                text = "Add timer",
                style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.primaryD,
            )
        }
        return
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.card, RoundedCornerShape(WF.radius.md))
            .border(1.dp, WF.colors.hair, RoundedCornerShape(WF.radius.md))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            WaffledTextField(
                value = minutes,
                onValueChange = { minutes = it.filter(Char::isDigit).take(3) },
                label = "MINUTES",
                placeholder = "0",
                modifier = Modifier.weight(1f),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
                ),
            )
            WaffledTextField(
                value = seconds,
                onValueChange = { seconds = it.filter(Char::isDigit).take(2) },
                label = "SECONDS",
                placeholder = "0",
                modifier = Modifier.weight(1f),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
                ),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.weight(1f)) {
                app.waffled.core.design.WaffledPrimaryCTA(
                    label = "Start ${CookTimer.mmss(total)}",
                    onClick = {
                        if (total > 0) {
                            onStart(total)
                            open = false
                            minutes = ""
                            seconds = ""
                        }
                    },
                    isDisabled = total <= 0,
                )
            }
            Box(Modifier.weight(1f)) {
                app.waffled.core.design.WaffledSecondaryCTA(
                    label = "Cancel",
                    onClick = {
                        open = false
                        minutes = ""
                        seconds = ""
                    },
                )
            }
        }
    }
}

/** One row of the floating dock: tap the time to jump to its step, pause, or drop it. */
@Composable
private fun TimerDockRow(
    timer: CookTimer,
    now: Long,
    onJump: () -> Unit,
    onTogglePause: () -> Unit,
    onDismiss: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        Modifier
            .fillMaxWidth()
            .wfShadow3(shape)
            .background(WF.colors.card, shape)
            .border(1.dp, WF.colors.hair, shape)
            .clip(shape)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).clickable(onClick = onJump),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Timer, null, tint = WF.colors.primaryD, modifier = Modifier.size(15.dp))
            Column {
                // Dish-qualified on a plate ("Potato Salad · Step 2"), so the dock names
                // what is beeping across every dish.
                Text(
                    text = timer.label,
                    style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Black, letterSpacing = 0.6.sp),
                    color = WF.colors.ink2,
                    maxLines = 1,
                )
                Text(
                    text = CookTimer.mmss(timer.remaining(now)),
                    style = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Black),
                    color = WF.colors.ink,
                )
            }
        }
        CircleButton(
            icon = if (timer.running) Icons.Filled.Close else Icons.Filled.PlayArrow,
            label = if (timer.running) "Pause" else "Resume",
            onClick = onTogglePause,
            tint = WF.colors.ink,
        )
        CircleButton(Icons.Filled.Close, "Dismiss timer", onDismiss, WF.colors.ink2)
    }
}

@Composable
private fun CircleButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: androidx.compose.ui.graphics.Color,
) {
    Box(
        Modifier
            .size(34.dp)
            .background(WF.colors.panel, CircleShape)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(14.dp))
    }
}

/** Full-screen "Timer done" alarm — Jump to step / +1:00 / Dismiss. */
@Composable
private fun AlarmOverlay(
    timer: CookTimer,
    onJump: () -> Unit,
    onAddMinute: () -> Unit,
    onDismiss: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            // The scrim token, not a hand-picked black: this is the same darkening layer
            // media captions sit on.
            .background(WF.colors.scrim)
            .clickable(enabled = false) {},
        contentAlignment = Alignment.Center,
    ) {
        val shape = RoundedCornerShape(WF.radius.lg)
        Column(
            Modifier
                .padding(28.dp)
                .widthIn(max = 360.dp)
                .wfShadow3(shape)
                .background(WF.colors.card, shape)
                .clip(shape)
                .padding(26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Icon(Icons.Filled.Timer, null, tint = WF.colors.primary, modifier = Modifier.size(44.dp))
            Text("Timer done", style = WF.type.serif(28.sp, FontWeight.Bold), color = WF.colors.ink)
            Text(
                text = timer.displayName,
                style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink2,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            InkButton("Jump to ${timer.stepLabel}", onJump)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f)) {
                    TintButton("+1:00", WF.colors.primary.copy(alpha = 0.14f), WF.colors.primaryD, onAddMinute)
                }
                Box(Modifier.weight(1f)) {
                    TintButton("Dismiss", WF.colors.panel, WF.colors.ink2, onDismiss)
                }
            }
        }
    }
}

/** A solid-`ink` button. Text on `ink` is `onInk` — white would vanish in dark. */
@Composable
private fun InkButton(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        Modifier
            .fillMaxWidth()
            .background(WF.colors.ink, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = WF.colors.onInk)
    }
}

@Composable
private fun TintButton(
    label: String,
    fill: androidx.compose.ui.graphics.Color,
    fg: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        Modifier
            .fillMaxWidth()
            .background(fill, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Bold), color = fg)
    }
}

@Composable
private fun CookNavBar(
    canGoBack: Boolean,
    isLast: Boolean,
    onBack: () -> Unit,
    onNext: () -> Unit,
    onFinish: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.weight(1f)) {
            app.waffled.core.design.WaffledSecondaryCTA("Back", onBack, isDisabled = !canGoBack)
        }
        Box(Modifier.weight(1f)) {
            if (isLast) {
                app.waffled.core.design.WaffledPrimaryCTA("✓ Finish & mark cooked", onFinish)
            } else {
                InkButton("Next", onNext)
            }
        }
    }
}

/**
 * The whole recipe in one sheet: every step (tap to jump) and the full ingredient list —
 * so the list button means "see the whole recipe", not just ingredients.
 */
@Composable
private fun CookOverviewSheet(
    title: String,
    steps: List<RecipeStepDTO>,
    ingredients: List<RecipeIngredientDTO>,
    currentIndex: Int,
    isTicked: (String) -> Boolean,
    tickedCount: Int,
    onToggleTick: (String) -> Unit,
    onPickStep: (Int) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(20.dp)
            .padding(bottom = WF.spacing.tabBarClearance),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        Text(title, style = WF.type.title, color = WF.colors.ink)

        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            app.waffled.core.design.SectionLabel("Steps")
            steps.forEachIndexed { i, st ->
                val isCurrent = i == currentIndex
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onPickStep(i) }
                        .padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        Modifier
                            .size(28.dp)
                            .background(
                                if (isCurrent) WF.colors.success else WF.colors.success.copy(alpha = 0.12f),
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "${st.stepNumber}",
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Black),
                            // White on the saturated success fill; the tinted one keeps
                            // the coloured text.
                            color = if (isCurrent) androidx.compose.ui.graphics.Color.White else WF.colors.success,
                        )
                    }
                    Text(
                        text = st.instruction,
                        modifier = Modifier.weight(1f),
                        style = TextStyle(
                            fontSize = 16.sp,
                            fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                        ),
                        color = WF.colors.ink,
                    )
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        null,
                        tint = WF.colors.ink3,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }

        if (ingredients.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    app.waffled.core.design.SectionLabel("Ingredients")
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = "$tickedCount of ${ingredients.size}",
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black, letterSpacing = 0.6.sp),
                        color = WF.colors.ink3,
                    )
                }
                for (ing in ingredients) {
                    val on = isTicked(ing.id)
                    val strike = if (on) TextDecoration.LineThrough else null
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .toggleable(value = on, role = Role.Checkbox) { onToggleTick(ing.id) }
                            .padding(vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        TickBox(on)
                        Text(
                            text = CookSession.amountText(ing),
                            modifier = Modifier.widthIn(min = 70.dp),
                            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textDecoration = strike),
                            color = if (on) WF.colors.ink3 else WF.colors.ink2,
                            textAlign = androidx.compose.ui.text.style.TextAlign.End,
                        )
                        Text(
                            text = CookSession.listName(ing),
                            style = TextStyle(fontSize = 16.sp, textDecoration = strike),
                            color = if (on) WF.colors.ink3 else WF.colors.ink,
                        )
                    }
                }
            }
        }
    }
}

/** The tick shared by the step chips and the overview list; the row owns the toggle. */
@Composable
private fun TickBox(on: Boolean) {
    androidx.compose.material3.Checkbox(
        checked = on,
        onCheckedChange = null,
        colors = androidx.compose.material3.CheckboxDefaults.colors(
            checkedColor = WF.colors.success,
            uncheckedColor = WF.colors.success,
            // White on the saturated success fill.
            checkmarkColor = androidx.compose.ui.graphics.Color.White,
        ),
        modifier = Modifier.size(20.dp),
    )
}
