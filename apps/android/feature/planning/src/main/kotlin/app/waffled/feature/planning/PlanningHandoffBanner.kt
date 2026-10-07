package app.waffled.feature.planning

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.feature.planning.api.LooseEndRoute
import app.waffled.feature.planning.api.ParkedTagChange
import app.waffled.feature.planning.api.PlanningStep
import app.waffled.feature.planning.api.PlanningStepHandoff
import kotlinx.coroutines.launch

/** Which words an answered note carries: the corrected ones, not the stored `note`. */
object PlanningHandoffWords {
    fun of(note: PlanningStepHandoff, edited: Map<String, String>): String = edited[note.id] ?: note.note
}

/**
 * Copy the banner shares with the Loose ends step. Named apart from that step's own copy
 * object so step 1 can define its own without a clash.
 */
object PlanningHandoffCopy {
    /** Falls back to the raw kind: kinds are server-owned and a newer server may add one. */
    fun kindLabel(kind: String): String = when (kind) {
        "chore" -> "Chore"
        "list" -> "List"
        "rhythm" -> "Rhythm"
        "parked" -> "Parked"
        else -> kind.replaceFirstChar { it.uppercase() }
    }

    const val WRITE_FAILED = "That didn’t go through — try again."
}

/**
 * EVERYTHING SOMEBODY SENT TO THIS STEP, in one gold box at the top of it. The shell owns
 * it, not the steps. Two halves: parked notes (free text, tagged for a step) and routed
 * loose ends (a verb only — routing wrote nothing, so there's nothing to answer).
 *
 * The caller must key this on the step (`key(step.key)`): the hidden/edited/made state is
 * per-row and a step change has to start it empty. Port of iOS `PlanningHandoffBanner`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlanningHandoffBanner(
    step: PlanningStep,
    /** EVERY route step 1 wrote this session; the box filters to its own step. */
    routes: List<LooseEndRoute>,
    busy: Boolean,
    verb: PlanningHandoffVerb?,
    /** Settle a parked note; true when the server took it. */
    resolve: suspend (id: String, action: String) -> Boolean,
    /** Fix a note; returns the server's refusal, or null when it took it. */
    update: suspend (id: String, note: String?, tag: ParkedTagChange) -> String?,
    /** The session's steps, for the edit tags: every runnable one but Loose ends. */
    steps: List<PlanningStep>,
    modifier: Modifier = Modifier,
) {
    var working by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<String?>(null) }
    var editError by remember { mutableStateOf<String?>(null) }
    val edited = remember { mutableStateMapOf<String, String>() }
    val hidden = remember { mutableStateMapOf<String, Boolean>() }
    val made = remember { mutableStateMapOf<String, Boolean>() }
    val scope = rememberCoroutineScope()

    // A missing field costs the banner, never the session screen.
    val notes = step.parked.orEmpty().filter { hidden[it.id] != true }
    val sent = PlanningRouteSeed.sentHere(step.key, routes, step.parked, made.keys)
    if (notes.isEmpty() && sent.isEmpty()) return

    val tags = steps.filter { it.available && it.key != PlanningStepKeys.LOOSE_ENDS }
        .map { PlanningParkedTag(it.key, it.title) }

    fun answer(id: String, action: String) {
        if (working != null) return
        working = id
        scope.launch {
            if (resolve(id, action)) hidden[id] = true
            working = null
        }
    }

    val shape = RoundedCornerShape(WF.radius.lg)
    Column(
        modifier
            .fillMaxWidth()
            .background(WF.colors.gold.copy(alpha = 0.10f), shape)
            .border(1.dp, WF.colors.gold.copy(alpha = 0.30f), shape)
            .clip(shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (notes.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BannerHeading(
                    "📌",
                    if (notes.size == 1) "You parked this for right here" else "You parked ${notes.size} things for right here",
                )
                notes.forEach { note ->
                    val words = PlanningHandoffWords.of(note, edited)
                    if (editing == note.id) {
                        PlanningParkedNoteEditor(
                            note = words,
                            stepKey = step.key,
                            tags = tags,
                            busy = busy,
                            errorMessage = editError,
                            onCancel = {
                                editing = null
                                editError = null
                            },
                            onSave = { text, tag ->
                                val refusal = update(note.id, text, tag)
                                if (refusal != null) {
                                    editError = refusal
                                    false
                                } else {
                                    editError = null
                                    if (text != null) edited[note.id] = text
                                    if (tag is ParkedTagChange.To && tag.stepKey != step.key) hidden[note.id] = true
                                    true
                                }
                            },
                        )
                    } else {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(words, style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = WF.colors.ink)
                            if (!note.byline.isNullOrEmpty()) {
                                Text(note.byline, style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3)
                            }
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                val rowWorking = working == note.id
                                if (verb != null) {
                                    PlanningPillButton(verb.label, {
                                        // The id is captured HERE, so a second composer opened
                                        // before the first reports back can't settle the wrong
                                        // note. A cancelled composer settles nothing.
                                        verb.run(words) { created -> if (created) answer(note.id, "done") }
                                    }, filled = true, disabled = busy, working = rowWorking)
                                }
                                PlanningPillButton(
                                    if (verb == null) "Handled" else "Already handled",
                                    { answer(note.id, "done") },
                                    tint = WF.colors.ink2, disabled = busy, working = rowWorking,
                                )
                                PlanningPillButton("Edit", {
                                    editError = null
                                    editing = note.id
                                }, tint = WF.colors.ink2, disabled = busy, working = rowWorking)
                                PlanningPillButton(
                                    "Drop it",
                                    { answer(note.id, "drop") },
                                    tint = WF.colors.danger, disabled = busy, working = rowWorking,
                                )
                            }
                        }
                    }
                }
            }
        }
        if (sent.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BannerHeading(
                    "➡️",
                    if (sent.size == 1) "You sent this here from loose ends" else "You sent ${sent.size} things here from loose ends",
                )
                sent.forEach { route ->
                    val key = PlanningRouteSeed.key(route)
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            route.title.ifEmpty { "Something you sent here" },
                            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                            color = WF.colors.ink,
                        )
                        Text(PlanningHandoffCopy.kindLabel(route.kind), style = TextStyle(fontSize = 11.5.sp), color = WF.colors.ink3)
                        if (verb != null) {
                            PlanningPillButton(verb.label, {
                                verb.run(route.title) { created -> if (created) made[key] = true }
                            }, filled = true, disabled = busy, working = working == key)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BannerHeading(emoji: String, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(emoji, style = TextStyle(fontSize = 14.sp))
        Text(text, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.ExtraBold), color = WF.colors.ink)
    }
}
