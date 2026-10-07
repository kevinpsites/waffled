package app.waffled.feature.capture

import app.waffled.core.model.Capability
import app.waffled.core.model.Currency
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * What the sheet needs to know about the household and the viewer. `app` builds it from
 * `SyncManager` (members, current person, zone, module gate) and passes it in.
 */
data class CaptureEnvironment(
    val members: List<Person> = emptyList(),
    val currentPersonId: String? = null,
    val zone: ZoneId = ZoneId.systemDefault(),
    val goalsOn: Boolean = true,
    val pantryOn: Boolean = false,
    /** `ModuleGate.rewardsOn(subEnabled)` — chores on AND the rewards sub-flag. */
    val rewardsOn: Boolean = true,
) {
    val currentPerson: Person? get() = members.firstOrNull { it.id == currentPersonId }

    fun can(capability: String): Boolean = currentPerson?.can(capability) == true

    fun member(named: String?): Person? = named?.let { n -> members.firstOrNull { it.name.equals(n, ignoreCase = true) } }
}

enum class CapturePhase { Input, Parsing, Preview, Committing }

/** The inline-editable fields behind the "Waffled understood" card, seeded per intent. */
data class CaptureDraft(
    /** The re-classifiable kind: event, list, grocery, task, meal, countdown, person, goal, pantry, reward, mutate. */
    val kind: String = "event",
    val name: String = "",
    // event (person also = task assignee)
    val eventDate: LocalDate = LocalDate.EPOCH,
    val eventTime: LocalTime = LocalTime.of(9, 0),
    val allDay: Boolean = false,
    val person: String? = null,
    val repeat: CaptureRepeat = CaptureRepeat(),
    val untilOn: Boolean = false,
    val until: LocalDate = LocalDate.EPOCH,
    // grocery / list
    val quantity: String = "",
    val listName: String = "",
    // task
    val taskStars: Int = 0,
    val taskCurrency: String = "stars",
    val taskRrule: String? = null,
    // meal
    val mealSlot: String = "dinner",
    val mealDate: LocalDate = LocalDate.EPOCH,
    // countdown
    val countdownDate: LocalDate = LocalDate.EPOCH,
    val countdownEmoji: String? = null,
    // person
    val personType: String = "adult",
    val personEmoji: String? = null,
    val personBirthday: String? = null,
    val personIsAdmin: Boolean = false,
    // goal
    val goalType: String = "habit",
    val goalTarget: String = "",
    val goalUnit: String = "",
    val goalDeadlineOn: Boolean = false,
    val goalDeadline: LocalDate = LocalDate.EPOCH,
    val goalTrackingMode: String = "shared_total",
    val goalEveryone: Boolean = false,
    // pantry
    val pantryAmount: String = "",
    val pantryUnit: String = "",
    val pantryLocation: String = "Pantry",
    val pantryExpiresOn: Boolean = false,
    val pantryExpires: LocalDate = LocalDate.EPOCH,
    val pantryLowAt: Double? = null,
    // reward
    val rewardEmoji: String = "",
    val rewardCost: String = "",
    /** null = inherit the household default. */
    val rewardRequiresApproval: Boolean? = null,
    // mutate
    val mutateVerb: String = "",
    val mutateTargetKind: String? = null,
    val mutateArgs: Map<String, JsonElement> = emptyMap(),
)

/** A resolved mutate. [forKey] (verb|targetKind|description) stops a stale result overwriting a newer parse. */
data class MutateResolveState(
    val candidates: List<CaptureCandidate>,
    val disabledReason: String?,
    val unsupported: Boolean,
    val offline: Boolean,
    val forKey: String,
)

data class CaptureUiState(
    val text: String = "",
    val phase: CapturePhase = CapturePhase.Input,
    val intent: CaptureIntent? = null,
    val via: String = "",
    /** The LLM is still improving the on-device guess. */
    val thinking: Boolean = false,
    /** The LLM's read when it disagrees with a confident on-device guess. */
    val serverAlt: CaptureIntent? = null,
    val serverAltVia: String = "",
    val error: String? = null,
    /** Glance → full field editor. */
    val editing: Boolean = false,
    val draft: CaptureDraft = CaptureDraft(),
    val mutateState: MutateResolveState? = null,
    val mutateChosenId: String? = null,
    val mutateResolveKey: String = "",
    val lists: List<CaptureList> = emptyList(),
    val currencies: List<Currency> = emptyList(),
    val environment: CaptureEnvironment = CaptureEnvironment(),
    /** A commit landed — the sheet should dismiss. */
    val done: Boolean = false,
) {
    val personBlocked: Boolean get() = draft.kind == "person" && environment.currentPerson?.isAdmin != true
    val goalBlocked: Boolean get() = draft.kind == "goal" && !environment.goalsOn
    val pantryBlocked: Boolean get() = draft.kind == "pantry" && !environment.pantryOn
    val rewardBlocked: Boolean
        get() = draft.kind == "reward" && (!environment.rewardsOn || !environment.can(Capability.REWARD_MANAGE))
    val rewardBlockedReason: String
        get() = if (!environment.rewardsOn) "Rewards are turned off." else "Ask a parent to add a reward."

    val canCommit: Boolean
        get() = draft.name.isNotBlank() &&
            (draft.kind != "list" || draft.listName.isNotBlank()) &&
            !personBlocked && !goalBlocked && !pantryBlocked && !rewardBlocked

    val rewardLabel: String get() = currencies.firstOrNull { it.key == draft.taskCurrency }?.label ?: "Stars"

    val addLabel: String
        get() = when (draft.kind) {
            "event" -> "Add event"
            "task" -> "Add task"
            "grocery" -> "Add to groceries"
            "list" -> "Add to list"
            "meal" -> "Add meal"
            "countdown" -> "Add countdown"
            "person" -> "Add family member"
            "goal" -> "Add goal"
            "pantry" -> "Add to pantry"
            "reward" -> "Add reward"
            else -> "Add"
        }

    val namePlaceholder: String
        get() = when (draft.kind) {
            "event" -> "Event title"
            "task" -> "Chore title"
            "meal" -> "Meal"
            "countdown" -> "Countdown title"
            "person" -> "Name"
            "goal" -> "Goal"
            "pantry" -> "Item"
            "reward" -> "Reward"
            else -> "Item"
        }

    val viaLabel: String
        get() = when (via) {
            "anthropic" -> "via Claude"
            "openai" -> "via OpenAI"
            "ollama" -> "via local LLM"
            "on-device" -> "on device"
            else -> ""
        }

    val altProviderLabel: String
        get() = when (serverAltVia) {
            "on-device" -> "The on-device guess"
            "anthropic" -> "Claude"
            "openai" -> "OpenAI"
            "ollama" -> "The local LLM"
            else -> "The other parse"
        }

    /** The one-line subtitle under the glance title, per kind. */
    val glanceDetail: String
        get() = when (draft.kind) {
            "event" -> buildString {
                append(fmt(draft.eventDate, "EEE, MMM d"))
                if (draft.allDay) append(" · all day") else append(" · ").append(fmtTime(draft.eventTime))
                draft.repeat.rrule(draft.eventDate)?.let {
                    append(" · 🔁 ").append(CaptureRecurrence.describeRrule(it, draft.eventDate))
                }
            }
            "task" -> (draft.person ?: "Up for grabs") +
                (if (draft.taskStars > 0) " · ${draft.taskStars} ${rewardLabel.lowercase()}" else "")
            "grocery" -> if (draft.quantity.isEmpty()) "Adds to the grocery list" else "${draft.quantity} · grocery list"
            "list" -> if (draft.listName.isEmpty()) "Adds to a list" else "Adds to ${draft.listName}"
            "meal" -> "${draft.mealSlot.replaceFirstChar { it.uppercase() }} · ${fmt(draft.mealDate, "EEE, MMM d")}"
            "countdown" -> fmt(draft.countdownDate, "EEE, MMM d")
            "person" -> CaptureSummary.memberTypeLabel(draft.personType)
            "goal" -> {
                val measured = draft.goalType == "count" || draft.goalType == "total"
                val target = if (measured && draft.goalTarget.isNotEmpty()) {
                    listOf(draft.goalTarget, draft.goalUnit).filter { it.isNotEmpty() }.joinToString(" ")
                } else {
                    ""
                }
                val by = if (draft.goalDeadlineOn) "by " + fmt(draft.goalDeadline, "MMM d") else ""
                listOf(CaptureSummary.goalTypeLabel(draft.goalType), target, by).filter { it.isNotEmpty() }.joinToString(" · ")
            }
            "pantry" -> listOf(
                "Adds to ${draft.pantryLocation}",
                if (draft.pantryExpiresOn) "expires " + fmt(draft.pantryExpires, "MMM d") else "",
            ).filter { it.isNotEmpty() }.joinToString(" · ")
            "reward" -> listOf(
                "Adds to the reward shop",
                draft.rewardCost.trim().let { if (it.isEmpty()) "" else "$it★" },
                if (draft.rewardRequiresApproval == true) "needs approval" else "",
            ).filter { it.isNotEmpty() }.joinToString(" · ")
            else -> ""
        }

    /** A compact "→ when / +amount / → who" line under a mutate's title. */
    val mutateArgsSummary: String
        get() {
            val args = draft.mutateArgs
            fun str(k: String) = (args[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            fun num(k: String) = (args[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            return when (draft.mutateVerb) {
                "reschedule" -> {
                    val parts = listOfNotNull(
                        str("date")?.let { d -> runCatching { fmt(LocalDate.parse(d), "EEE, MMM d") }.getOrDefault(d) },
                        str("time")?.let { t -> runCatching { fmtTime(LocalTime.parse(t)) }.getOrDefault(t) },
                    )
                    if (parts.isEmpty()) "" else "→ " + parts.joinToString(" · ")
                }
                "log" -> num("hours")?.let { "+${trimNumber(it)} hours" }
                    ?: num("minutes")?.let { "+${trimNumber(it)} minutes" }
                    ?: num("amount")?.let { "+${trimNumber(it)}" }
                    ?: ""
                "reassign" -> str("personName")?.let { "→ $it" } ?: ""
                else -> ""
            }
        }

    /** The emoji tile for the current kind. */
    val kindIcon: String get() = CaptureKinds.all.firstOrNull { it.key == draft.kind }?.icon ?: "✨"

    private companion object {
        val formatters = ConcurrentHashMap<String, DateTimeFormatter>()
        fun fmt(d: LocalDate, pattern: String): String =
            formatters.getOrPut(pattern) { DateTimeFormatter.ofPattern(pattern, Locale.US) }.format(d)
        fun fmtTime(t: LocalTime): String =
            formatters.getOrPut("h:mm a") { DateTimeFormatter.ofPattern("h:mm a", Locale.US) }.format(t)
    }
}

/** The kinds the editor can re-classify between — order and icons as on iOS. */
object CaptureKinds {
    data class Kind(val key: String, val icon: String, val label: String)

    val all = listOf(
        Kind("event", "📅", "Event"), Kind("list", "📝", "List"), Kind("grocery", "🛒", "Grocery"),
        Kind("task", "✅", "Task"), Kind("meal", "🍽️", "Meal"), Kind("countdown", "⏳", "Countdown"),
        Kind("person", "👤", "Family member"), Kind("goal", "🎯", "Goal"), Kind("pantry", "🥫", "Pantry"),
        Kind("reward", "🎁", "Reward"),
    )
}

/**
 * The "Add anything" sheet's state machine — the port of the logic in iOS `CaptureSheet`.
 *
 * Parse is two-stage: the on-device [CaptureHeuristic] answers instantly when confident,
 * then the server's LLM upgrades it in the background. A mutate (act on an existing row)
 * resolves to candidates the user picks from before it commits — never auto-committed.
 */
class CaptureModel(
    private val service: CaptureService,
    private val scope: CoroutineScope,
    private val refreshBus: RefreshBus? = null,
    private val now: () -> Instant = Instant::now,
) {
    private val _state = MutableStateFlow(CaptureUiState())
    val state: StateFlow<CaptureUiState> = _state.asStateFlow()

    private val env get() = _state.value.environment
    private fun today(): LocalDate = now().atZone(env.zone).toLocalDate()

    fun updateEnvironment(environment: CaptureEnvironment) = _state.update { it.copy(environment = environment) }

    /** Pre-warm the model and load the list / currency pickers — off the focus path. */
    fun onOpen() {
        scope.launch { service.warm() }
        scope.launch {
            val lists = async { runCatching { service.lists() }.getOrNull() }
            val currencies = async { runCatching { service.currencies() }.getOrNull() }
            _state.update { s ->
                s.copy(lists = lists.await() ?: s.lists, currencies = currencies.await() ?: s.currencies)
            }
        }
    }

    fun setText(text: String) = _state.update { it.copy(text = text) }

    fun updateDraft(transform: (CaptureDraft) -> CaptureDraft) = _state.update { it.copy(draft = transform(it.draft)) }

    fun startEditing() = _state.update { it.copy(editing = true) }

    /** "Edit text": back to the input, re-arming a mutate resolve for the next parse. */
    fun editText() = _state.update { it.copy(phase = CapturePhase.Input, mutateResolveKey = "") }

    fun clearError() = _state.update { it.copy(error = null) }

    /** Everything back to a fresh open (state otherwise survives a dismiss). */
    fun reset() = _state.update { CaptureUiState(lists = it.lists, currencies = it.currencies, environment = it.environment) }

    fun parse() {
        val t = _state.value.text.trim()
        if (t.isEmpty()) return
        _state.update { it.copy(error = null, serverAlt = null) }

        val zoned = now().atZone(env.zone)
        val local = CaptureHeuristic.parse(t, env.members.map { it.name }, zoned, _state.value.lists.map { it.name })
        val localConfident = local != null && CaptureHeuristic.looksConfident(local, t)
        if (local != null && localConfident) accept(local, "on-device") else _state.update { it.copy(phase = CapturePhase.Parsing) }
        _state.update { it.copy(thinking = true) }

        scope.launch {
            val r = runCatching { service.parse(t) }.getOrNull()
            val s = _state.value
            // The user changed the text meanwhile, or opened the editor — don't clobber.
            if (s.text.trim() != t || s.editing) {
                _state.update { it.copy(thinking = false, phase = if (it.phase == CapturePhase.Parsing) CapturePhase.Input else it.phase) }
                return@launch
            }
            _state.update { it.copy(thinking = false) }
            val si = r?.intent
            if (si != null && !r.fallback) {
                if (localConfident && local != null && si.kind != local.kind) {
                    _state.update { it.copy(serverAlt = si, serverAltVia = r.via) }
                } else {
                    accept(mergeRecurrence(si, local), r.via)
                }
            } else if (!localConfident) {
                if (local != null) {
                    accept(local, "on-device")
                } else {
                    _state.update { it.copy(error = "Couldn’t understand that — try rephrasing.", phase = CapturePhase.Input) }
                }
            }
        }
    }

    /** Swap to the other parse (LLM ↔ on-device), keeping the previous one offered. */
    fun switchToAlt() {
        val s = _state.value
        val alt = s.serverAlt ?: return
        val prev = s.intent
        val prevVia = s.via
        accept(alt, s.serverAltVia)
        _state.update { it.copy(serverAlt = prev, serverAltVia = if (prev != null) prevVia else "") }
    }

    fun chooseCandidate(id: String) = _state.update { it.copy(mutateChosenId = id) }

    private fun accept(intent: CaptureIntent, via: String) {
        _state.update { it.copy(intent = intent, via = via, phase = CapturePhase.Preview, editing = false) }
        populate(intent)
    }

    /** Keep the heuristic's recurrence when the LLM agreed it's an event but returned a one-off. */
    private fun mergeRecurrence(llm: CaptureIntent, local: CaptureIntent?): CaptureIntent {
        if (llm !is CaptureIntent.Event || llm.rrule != null) return llm
        if (local !is CaptureIntent.Event || local.rrule == null) return llm
        return llm.copy(rrule = local.rrule, scheduleLabel = local.scheduleLabel.ifEmpty { llm.scheduleLabel })
    }

    private fun populate(intent: CaptureIntent) {
        val today = today()
        // Every date field starts at today, so re-classifying lands on a sensible day.
        val base = _state.value.draft.copy(
            eventDate = today, until = today, mealDate = today, countdownDate = today,
            goalDeadline = today, pantryExpires = today,
        )
        fun day(s: String?): LocalDate? = s?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }
        val d = when (intent) {
            is CaptureIntent.Event -> {
                val start = runCatching { Instant.parse(intent.startsAt).atZone(env.zone) }.getOrNull()
                base.copy(
                    kind = "event", name = intent.title, allDay = intent.allDay,
                    // A bare event's owner defaults to the viewer; a parsed name wins.
                    person = intent.personName ?: env.currentPerson?.name,
                    eventDate = start?.toLocalDate() ?: today,
                    eventTime = start?.toLocalTime()?.withSecond(0)?.withNano(0) ?: base.eventTime,
                    repeat = CaptureRepeat.parse(intent.rrule), untilOn = false,
                )
            }
            is CaptureIntent.Grocery -> base.copy(kind = "grocery", name = intent.name, quantity = intent.quantity.orEmpty())
            is CaptureIntent.Task -> base.copy(
                kind = "task", name = intent.title, person = intent.personName,
                taskStars = intent.stars ?: 0, taskRrule = intent.rrule,
            )
            is CaptureIntent.Meal -> base.copy(kind = "meal", name = intent.title, mealSlot = intent.mealType, mealDate = day(intent.date) ?: today)
            is CaptureIntent.ListItem -> base.copy(
                kind = "list", name = intent.itemName, quantity = intent.quantity.orEmpty(),
                listName = intent.listName ?: _state.value.lists.firstOrNull { !it.isGrocery }?.name.orEmpty(),
            )
            is CaptureIntent.Countdown -> base.copy(
                kind = "countdown", name = intent.title, countdownEmoji = intent.emoji, countdownDate = day(intent.date) ?: today,
            )
            is CaptureIntent.Person -> base.copy(
                kind = "person", name = intent.name, personType = intent.memberType,
                personEmoji = intent.avatarEmoji, personBirthday = intent.birthday, personIsAdmin = intent.isAdmin,
            )
            is CaptureIntent.Goal -> {
                val deadline = day(intent.deadline)
                base.copy(
                    kind = "goal", name = intent.title, goalType = intent.goalType, goalTrackingMode = intent.trackingMode,
                    // A viewer without goal.manage can only make a just-me goal.
                    goalEveryone = intent.audience == "everyone" && env.can(Capability.GOAL_MANAGE),
                    goalUnit = intent.unit.orEmpty(), goalTarget = intent.targetValue?.let(::trimNumber).orEmpty(),
                    goalDeadlineOn = deadline != null, goalDeadline = deadline ?: today,
                )
            }
            is CaptureIntent.Pantry -> {
                val expires = day(intent.expiresOn)
                base.copy(
                    kind = "pantry", name = intent.name, pantryAmount = intent.amount.orEmpty(), pantryUnit = intent.unit.orEmpty(),
                    pantryLocation = intent.location.ifEmpty { "Pantry" }, pantryLowAt = intent.lowAt,
                    pantryExpiresOn = expires != null, pantryExpires = expires ?: today,
                )
            }
            is CaptureIntent.Reward -> base.copy(
                kind = "reward", name = intent.title, rewardEmoji = intent.emoji.orEmpty(),
                rewardCost = intent.cost?.toString().orEmpty(), rewardRequiresApproval = intent.requiresApproval,
            )
            is CaptureIntent.Mutate -> base.copy(
                kind = "mutate", name = intent.description, mutateVerb = intent.verb,
                mutateTargetKind = intent.targetKind, mutateArgs = intent.args,
            )
        }
        _state.update { it.copy(draft = d) }
        if (intent is CaptureIntent.Mutate) triggerMutateResolve()
    }

    /** Resolve the mutate marker; a re-parse to the SAME target doesn't re-resolve. */
    private fun triggerMutateResolve() {
        val d = _state.value.draft
        val key = "${d.mutateVerb}|${d.mutateTargetKind.orEmpty()}|${d.name}"
        if (key == _state.value.mutateResolveKey) return
        _state.update { it.copy(mutateResolveKey = key, mutateState = null, mutateChosenId = null) }
        scope.launch {
            val r = runCatching { service.resolve(d.mutateVerb, d.mutateTargetKind, d.name, d.mutateArgs) }.getOrNull()
            val resolved = if (r != null) {
                MutateResolveState(r.candidates, r.disabledReason, r.unsupported, offline = false, forKey = key)
            } else {
                MutateResolveState(emptyList(), null, unsupported = false, offline = true, forKey = key)
            }
            _state.update { s ->
                if (s.mutateResolveKey != key) return@update s // superseded by a newer parse
                s.copy(mutateState = resolved, mutateChosenId = resolved.candidates.singleOrNull()?.id)
            }
        }
    }

    fun commit() {
        val s = _state.value
        if (s.draft.kind == "mutate") return commitMutate()
        val d = s.draft
        val blockedReason = when {
            s.personBlocked -> "Only an adult can add family members."
            s.goalBlocked -> "Goals is turned off. Turn it on in Settings → Modules."
            s.pantryBlocked -> "The Pantry module is turned off. Turn it on in Settings → Modules."
            s.rewardBlocked -> s.rewardBlockedReason
            else -> null
        }
        if (blockedReason != null) {
            _state.update { it.copy(error = blockedReason, phase = CapturePhase.Preview) }
            return
        }
        _state.update { it.copy(error = null, phase = CapturePhase.Committing) }
        val name = d.name.trim()
        val qty = d.quantity.trim().ifEmpty { null }
        scope.launch {
            val result = runCatching { commitCreate(d, name, qty) }
            result.fold(
                onSuccess = { domain ->
                    domain?.let { refreshBus?.bump(it) }
                    _state.update { it.copy(phase = CapturePhase.Preview, done = true) }
                },
                onFailure = { e -> _state.update { it.copy(error = errorText(e, "Couldn't add that."), phase = CapturePhase.Preview) } },
            )
        }
    }

    /** Perform the create; returns the REST domain to refresh (null when PowerSync or nothing shows it). */
    private suspend fun commitCreate(d: CaptureDraft, name: String, qty: String?): RefreshDomain? {
        val e = env
        return when (d.kind) {
            "event" -> {
                val start = (if (d.allDay) d.eventDate.atTime(LocalTime.NOON) else d.eventDate.atTime(d.eventTime)).atZone(e.zone)
                val rrule = d.repeat.rrule(d.eventDate)
                val until = if (rrule != null && d.untilOn) d.until.atTime(23, 59).atZone(e.zone).toInstant().toString() else null
                service.createEvent(
                    title = name,
                    startsAtIso = start.toInstant().toString(),
                    endsAtIso = if (d.allDay) null else start.plusHours(1).toInstant().toString(),
                    allDay = d.allDay,
                    personIds = listOfNotNull(e.member(d.person)?.id),
                    timezone = e.zone.id,
                    rrule = rrule,
                    recurrenceEndAt = until,
                )
                null // events down-sync through PowerSync
            }
            "grocery" -> {
                service.addGroceryItem(if (qty == null) name else "$name ($qty)")
                RefreshDomain.Lists
            }
            "task" -> {
                service.createChore(name, e.member(d.person)?.id, d.taskStars.takeIf { it > 0 }, d.taskCurrency, d.taskRrule)
                RefreshDomain.Chores
            }
            "meal" -> {
                val recipes = runCatching { service.recipes() }.getOrDefault(emptyList())
                val n = name.lowercase()
                val recipeId = recipes.firstOrNull { it.title.orEmpty().lowercase() == n }?.id
                    ?: recipes.firstOrNull { it.title.orEmpty().lowercase().contains(n) }?.id
                service.planMeal(d.mealDate.toString(), d.mealSlot, recipeId, if (recipeId == null) name else null)
                RefreshDomain.Meals
            }
            "list" -> {
                val lists = service.lists()
                val wanted = d.listName.trim()
                val target = lists.firstOrNull { it.name.equals(wanted, ignoreCase = true) }
                    ?: if (wanted.isNotEmpty()) service.createList(wanted) else throw WaffledApiException(0, "No matching list.")
                service.addListItem(target.id, name, qty)
                RefreshDomain.Lists
            }
            "countdown" -> {
                service.createCountdown(name, d.countdownDate.toString(), d.countdownEmoji)
                null
            }
            "person" -> {
                service.createPerson(name, d.personType, d.personEmoji, d.personBirthday, d.personIsAdmin)
                null
            }
            "goal" -> {
                // count/total carry a number; one with no real number downgrades to a habit.
                val measured = d.goalType == "count" || d.goalType == "total"
                val target = if (measured) d.goalTarget.trim().toDoubleOrNull() else null
                val type = if (measured && target == null) "habit" else d.goalType
                val keepsTarget = type == "count" || type == "total"
                val everyone = d.goalEveryone && e.can(Capability.GOAL_MANAGE)
                service.createGoal(
                    title = name,
                    goalType = type,
                    trackingMode = d.goalTrackingMode,
                    targetValue = if (keepsTarget) target else null,
                    unit = if (keepsTarget) d.goalUnit.trim().ifEmpty { null } else null,
                    deadline = if (d.goalDeadlineOn) d.goalDeadline.toString() else null,
                    participantIds = if (everyone) e.members.map { it.id } else listOfNotNull(e.currentPersonId),
                )
                RefreshDomain.Goals
            }
            "pantry" -> {
                service.createPantryItem(
                    name, d.pantryAmount.trim().ifEmpty { null }, d.pantryUnit.trim().ifEmpty { null },
                    d.pantryLocation.ifEmpty { "Pantry" }, if (d.pantryExpiresOn) d.pantryExpires.toString() else null, d.pantryLowAt,
                )
                RefreshDomain.Pantry
            }
            "reward" -> {
                service.createReward(
                    name, d.rewardEmoji.trim().ifEmpty { null },
                    d.rewardCost.trim().toIntOrNull()?.coerceAtLeast(0), d.rewardRequiresApproval,
                )
                RefreshDomain.Rewards
            }
            else -> throw WaffledApiException(0, "Couldn't add that.")
        }
    }

    /** Commit the picked candidate; with no pick it is a no-op (a mutate is never implicit). */
    private fun commitMutate() {
        val s = _state.value
        val id = s.mutateChosenId
        val chosen = s.mutateState?.candidates?.firstOrNull { it.id == id }
        if (id == null || chosen == null) {
            _state.update { it.copy(phase = CapturePhase.Preview) }
            return
        }
        _state.update { it.copy(error = null, phase = CapturePhase.Committing) }
        val d = s.draft
        scope.launch {
            runCatching { service.commitMutate(d.mutateVerb, d.mutateTargetKind, id, d.mutateArgs, chosen.meta) }.fold(
                onSuccess = {
                    mutateDomain(d.mutateTargetKind)?.let { refreshBus?.bump(it) }
                    _state.update { it.copy(phase = CapturePhase.Preview, done = true) }
                },
                onFailure = { e -> _state.update { it.copy(error = errorText(e, "Couldn’t do that — try again."), phase = CapturePhase.Preview) } },
            )
        }
    }

    private fun mutateDomain(targetKind: String?): RefreshDomain? = when (targetKind) {
        "chore" -> RefreshDomain.Chores
        "goal" -> RefreshDomain.Goals
        "listItem" -> RefreshDomain.Lists
        "reward" -> RefreshDomain.Rewards
        else -> null // events down-sync through PowerSync
    }

    private fun errorText(e: Throwable, fallback: String): String =
        (e as? WaffledApiException)?.userMessage?.takeIf { it.isNotBlank() } ?: fallback
}
