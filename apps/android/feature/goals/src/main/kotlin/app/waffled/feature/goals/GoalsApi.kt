package app.waffled.feature.goals

import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The goals slice of the API — the Kotlin port of the `goals` / `goal-lists` /
 * `goal-calendar` endpoints in `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * **Goals are ONLINE-ONLY.** They are not a PowerSync table, so every read here is a live
 * REST call and every write is followed by a re-fetch plus a `RefreshDomain.Goals` bump —
 * nothing else would ever hear about the change.
 *
 * Bodies are built as [JsonObject]s rather than data classes because `WaffledJson` sets
 * `explicitNulls = false`: a nullable property is *omitted*, which silently turns "clear
 * this" into "leave it alone". That distinction is load-bearing twice over here, and the
 * two cases pull in OPPOSITE directions:
 *
 *  - **Clearable** — `goalListId`, `unit`, `deadline`, a log's `note`. These must reach
 *    the server as an explicit `JsonNull` or the old value survives an edit that
 *    visibly removed it.
 *  - **Preserve-only** — `healthMetric`, `healthDailyTarget`. Android has no health
 *    source (Health Connect is deliberately out of scope), so it must never send these
 *    at all. iOS sends an explicit null when its toggle is off; copying that would wipe
 *    the Apple Health link off any goal the moment someone edited it from their phone.
 */
class GoalsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    /**
     * A goal-list membership group (Family, an individual, a couple…). [members] drives
     * the avatar stack and the "Personal / Kevin & Kelly / Everyone" subline.
     */
    @Serializable
    data class GoalList(
        val id: String,
        val name: String = "",
        val emoji: String? = null,
        val colorHex: String? = null,
        val goalCount: Int = 0,
        val members: List<Member> = emptyList(),
    ) {
        @Serializable
        data class Member(
            val personId: String,
            val name: String = "",
            val avatarEmoji: String? = null,
            val colorHex: String? = null,
        )
    }

    /** Someone's slice of a goal — their own target (when each tracks) and progress. */
    @Serializable
    data class Participant(
        val personId: String,
        val name: String = "",
        val colorHex: String? = null,
        val avatarEmoji: String? = null,
        val target: Double? = null,
        val progress: Double = 0.0,
    )

    /** A goal with its rolled-up progress plus per-person contributions. */
    @Serializable
    data class Goal(
        val id: String,
        val goalListId: String? = null,
        val title: String = "",
        val emoji: String? = null,
        val category: String? = null,
        val goalType: String = "total",
        val unit: String? = null,
        val habitPeriod: String? = null,
        val habitTargetPerPeriod: Int? = null,
        val trackingMode: String = "shared_total",
        /**
         * How a SHARED goal counts a multi-person entry: `count_once` | `split`. Nullable
         * so an older/cached response still decodes; read it through [countsOnce].
         */
        val participantMode: String? = null,
        /** For `each_tracks`: `family` (flat target) | `per_person` (target × members). */
        val targetBasis: String? = null,
        val deadline: String? = null,
        val isFeatured: Boolean = false,
        /** The one hero goal per list ("Spotlight"). [isFeatured] is the "Pinned" tier. */
        val isSpotlight: Boolean? = null,
        val target: Double? = null,
        val totalProgress: Double = 0.0,
        val milestoneTotal: Int = 0,
        val milestoneReached: Int = 0,
        val streakDays: Int = 0,
        /** Opted in to counting matching calendar events (drives "Plan time"). */
        val autoFromCalendar: Boolean = false,
        /**
         * The Apple Health metric this goal auto-fills from, configured on iOS. Android
         * has no health source, so this is DISPLAY-ONLY and must never be written back.
         */
        val healthMetric: String? = null,
        val createdAt: String? = null,
        val participants: List<Participant> = emptyList(),
    ) {
        val spotlight: Boolean get() = isSpotlight == true
        val countsOnce: Boolean get() = (participantMode ?: "count_once") == "count_once"
    }

    /**
     * A goal's full detail read: the goal's fields plus its milestone ladder, checklist
     * steps, recent activity, this-week total and start date.
     */
    @Serializable
    data class GoalDetail(
        val id: String,
        val goalListId: String? = null,
        val title: String = "",
        val emoji: String? = null,
        val category: String? = null,
        val goalType: String = "total",
        val unit: String? = null,
        val target: Double? = null,
        val trackingMode: String = "shared_total",
        val participantMode: String? = null,
        val targetBasis: String? = null,
        val habitPeriod: String? = null,
        val habitTargetPerPeriod: Int? = null,
        val isFeatured: Boolean = false,
        val isSpotlight: Boolean? = null,
        val hasRewards: Boolean = false,
        val totalProgress: Double = 0.0,
        val streakDays: Int = 0,
        val deadline: String? = null,
        val createdAt: String = "",
        val thisWeek: Double = 0.0,
        val autoFromCalendar: Boolean = false,
        val healthMetric: String? = null,
        /** Daily threshold for a health-linked habit; null otherwise. Display-only. */
        val healthDailyTarget: Double? = null,
        val participants: List<Participant> = emptyList(),
        val milestones: List<Milestone> = emptyList(),
        val steps: List<Step> = emptyList(),
        val recent: List<LogEntry> = emptyList(),
    ) {
        /** A checklist goal's steps; empty for every other type. */
        @Serializable
        data class Step(
            val id: String,
            val label: String = "",
            val done: Boolean = false,
            val doneBy: String? = null,
        )

        @Serializable
        data class Milestone(
            val id: String,
            val threshold: Double = 0.0,
            val emoji: String? = null,
            val label: String? = null,
            val rewardText: String? = null,
            val reached: Boolean = false,
        )

        @Serializable
        data class LogEntry(
            val id: String,
            val amount: Double = 0.0,
            val loggedAt: String = "",
            /**
             * The HOUSEHOLD-timezone day (`yyyy-MM-dd`), bucketed exactly as the
             * `/activity` route does. Match an entry to a day with this — never with a
             * re-parse of [loggedAt], which would bucket by the device's own zone.
             */
            val dateKey: String = "",
            val note: String? = null,
            /**
             * Split-pool logs collapse to one entry: [amount] is the summed total and
             * this lists everyone credited (empty for a family/shared log).
             */
            val participants: List<Credited> = emptyList(),
        ) {
            @Serializable
            data class Credited(
                val personId: String? = null,
                val name: String? = null,
                val avatarEmoji: String? = null,
                val colorHex: String? = null,
            )
        }
    }

    /**
     * Day-bucketed log history — the input to [GoalSeriesBuilder].
     *
     * Days are keyed by household-LOCAL date and bucketed server-side the same way as the
     * goal's streak, so anything derived from this matches the streak shown elsewhere.
     * **Only days with activity appear** — the sparseness is meaningful, not a gap to
     * fill (see the absence rule on [GoalSeriesBuilder]).
     */
    @Serializable
    data class GoalActivity(
        val startDate: String = "",
        val endDate: String? = null,
        val today: String = "",
        val days: List<Day> = emptyList(),
    ) {
        @Serializable
        data class Day(
            val dateKey: String = "",
            val total: Double = 0.0,
            /** May hold a key at 0 — an attendee who was present but not credited. */
            val perMember: Map<String, Double> = emptyMap(),
        )

        /** The day rows as the stats/series layer wants them. */
        fun entries(): List<DayEntry> = days.map { DayEntry(it.dateKey, it.total, it.perMember) }
    }

    /**
     * A *confirmed* link: an event the household agreed ties to a goal, now ended and
     * waiting to be logged. [suggestedAmount] is an editable default. For checklist goals
     * [goalStepId] / [stepLabel] say which step a confirm ticks (the amount is ignored).
     */
    @Serializable
    data class GoalRecapItem(
        val eventId: String,
        val occurrenceDate: String = "",
        val title: String = "",
        val startsAt: String = "",
        val endsAt: String? = null,
        val allDay: Boolean = false,
        val goalId: String = "",
        val goalTitle: String = "",
        val goalEmoji: String? = null,
        /** total | count | habit | checklist */
        val goalType: String = "total",
        val unit: String? = null,
        /** shared_total | each_tracks */
        val trackingMode: String = "shared_total",
        val suggestedAmount: Double = 0.0,
        val defaultPersonIds: List<String> = emptyList(),
        val goalParticipantIds: List<String> = emptyList(),
        val goalStepId: String? = null,
        val stepLabel: String? = null,
    ) {
        /**
         * The identity the whole bridge is idempotent on. The server dedupes on the same
         * triple, so a replayed confirm is a no-op rather than double progress.
         */
        val id: String get() = "$eventId|$occurrenceDate|$goalId"

        /** Amount-based goals get an editable stepper; habits and checklists don't. */
        val isAmountBased: Boolean get() = goalType == "total" || goalType == "count"
    }

    /**
     * A *suggested* link: an untagged event the matcher thinks might count toward
     * [goalId] (best single match). Link it, or dismiss it for good.
     */
    @Serializable
    data class GoalSuggestionItem(
        val eventId: String,
        val title: String = "",
        val startsAt: String = "",
        val allDay: Boolean = false,
        val goalId: String = "",
        val goalTitle: String = "",
        val goalEmoji: String? = null,
        /** memory | keyword | llm */
        val via: String? = null,
    ) {
        val id: String get() = eventId
    }

    /** A live single-event goal match for the event editor's inline hint. Read-only. */
    @Serializable
    data class GoalSuggestOne(
        val goalId: String,
        val goalTitle: String = "",
        val goalEmoji: String? = null,
        val via: String? = null,
        /**
         * True when the learned memory score crosses the server's auto-link threshold —
         * confident enough to pre-link, which a one-off keyword/LLM guess never is.
         */
        val auto: Boolean? = null,
    )

    @Serializable private data class ListsEnvelope(val lists: List<GoalList> = emptyList())
    @Serializable private data class GoalsEnvelope(val goals: List<Goal> = emptyList())
    @Serializable private data class GoalEnvelope(val goal: GoalDetail)
    @Serializable private data class NewListEnvelope(val list: NewList) {
        @Serializable data class NewList(val id: String)
    }
    @Serializable private data class SuggestionsEnvelope(val suggestions: List<String> = emptyList())
    @Serializable private data class RecapEnvelope(val items: List<GoalRecapItem> = emptyList())
    @Serializable private data class SuggestEnvelope(val items: List<GoalSuggestionItem> = emptyList())
    @Serializable private data class SuggestOneEnvelope(val suggestion: GoalSuggestOne? = null)

    // ---- lists -----------------------------------------------------------------

    /** The household's goal lists — the membership picker. */
    suspend fun goalLists(): List<GoalList> =
        send<ListsEnvelope>(HttpMethod.Get, "api/goal-lists").lists

    /** Create a membership group. Returns the new list's id. */
    suspend fun addGoalList(
        name: String,
        emoji: String?,
        memberIds: List<String>,
        isPrivate: Boolean,
    ): String = send<NewListEnvelope>(HttpMethod.Post, "api/goal-lists") {
        jsonBody(
            buildJsonObject {
                put("name", name)
                put("isPrivate", isPrivate)
                // Explicit null: a group created without an emoji must not inherit one.
                put("emoji", emoji?.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull)
                if (memberIds.isNotEmpty()) put("memberIds", stringArray(memberIds))
            },
        )
    }.list.id

    // ---- goals -----------------------------------------------------------------

    /** The goals in a list — or, with a null [listId], every goal in the household. */
    suspend fun goalsIn(listId: String?): List<Goal> {
        val path = if (listId.isNullOrBlank()) {
            "api/goals"
        } else {
            "api/goals?listId=${listId.encodeURLParameter()}"
        }
        return send<GoalsEnvelope>(HttpMethod.Get, path).goals
    }

    /** One goal's full detail: milestones, steps, recent activity, this-week, streak. */
    suspend fun goalDetail(id: String): GoalDetail =
        send<GoalEnvelope>(HttpMethod.Get, "api/goals/$id").goal

    /** A goal's day-bucketed activity, for the data views. */
    suspend fun goalActivity(id: String): GoalActivity =
        send(HttpMethod.Get, "api/goals/$id/activity")

    /**
     * The notes already logged against this goal, most-used first — the log sheet's chip
     * row. [personId] scopes to the notes where that person was credited, so each
     * member's box learns their own history. A failure is the caller's to swallow.
     */
    suspend fun noteSuggestions(goalId: String, personId: String?): List<String> {
        val path = buildString {
            append("api/goals/$goalId/note-suggestions")
            if (!personId.isNullOrBlank()) append("?personId=${personId.encodeURLParameter()}")
        }
        return send<SuggestionsEnvelope>(HttpMethod.Get, path).suggestions
    }

    /**
     * Log progress. [amount] may be negative to correct a mistake, and is credited to
     * [personIds] — one log per person, so the per-person sums roll up to the pool. An
     * empty list is an unattributed pool entry.
     *
     * A TIME goal sends [hours] + [minutes] and lets the server fold them to decimal
     * hours; everything else sends [amount]. The two are mutually exclusive — the server
     * 400s if both arrive — so "10 min" never has to become 0.1666… on the client.
     *
     * [loggedOn] (`yyyy-MM-dd`) backdates the entry to catch up a missed day and keep a
     * streak alive; null logs against today.
     */
    suspend fun logProgress(
        goalId: String,
        amount: Double,
        personIds: List<String> = emptyList(),
        note: String? = null,
        loggedOn: String? = null,
        hours: Int? = null,
        minutes: Int? = null,
    ) {
        val body = buildJsonObject {
            if (hours != null || minutes != null) {
                put("hours", hours ?: 0)
                put("minutes", minutes ?: 0)
            } else {
                put("amount", amount)
            }
            if (personIds.isNotEmpty()) put("personIds", stringArray(personIds))
            note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it) }
            loggedOn?.takeIf { it.isNotBlank() }?.let { put("loggedOn", it) }
        }
        sendUnit(HttpMethod.Post, "api/goals/$goalId/log") { jsonBody(body) }
    }

    /** Tick / untick a checklist step. The server recomputes the goal's done/total. */
    suspend fun tickStep(goalId: String, stepId: String, done: Boolean) {
        sendUnit(HttpMethod.Patch, "api/goals/$goalId/steps/$stepId") {
            jsonBody(buildJsonObject { put("done", done) })
        }
    }

    /**
     * Edit a logged entry. Any field left null here is OMITTED, which the server reads as
     * "leave it alone" — except [note], where an emptied box is a deliberate clear and so
     * goes over the wire as an explicit JSON null.
     */
    suspend fun editLog(
        goalId: String,
        logId: String,
        amount: Double? = null,
        personIds: List<String>? = null,
        note: String? = null,
        loggedOn: String? = null,
    ) {
        val body = buildJsonObject {
            amount?.let { put("amount", it) }
            personIds?.let { put("personIds", stringArray(it)) }
            // An emptied note CLEARS the note — that has to be an explicit null.
            note?.let { put("note", it.trim().takeIf(String::isNotEmpty)?.let(::JsonPrimitive) ?: JsonNull) }
            loggedOn?.takeIf { it.isNotBlank() }?.let { put("loggedOn", it) }
        }
        sendUnit(HttpMethod.Patch, "api/goals/$goalId/logs/$logId") { jsonBody(body) }
    }

    /** Delete a logged entry — the whole batch if it was split across people. */
    suspend fun deleteLog(goalId: String, logId: String) {
        sendUnit(HttpMethod.Delete, "api/goals/$goalId/logs/$logId")
    }

    /**
     * Create a goal. Build the body with [GoalDraft.body] — it owns the required fields
     * and the clearable/preserve-only split.
     */
    suspend fun createGoal(body: JsonObject) {
        sendUnit(HttpMethod.Post, "api/goals") { jsonBody(body) }
    }

    /** Update a goal — the server's PATCH accepts any subset of the create field set. */
    suspend fun updateGoal(id: String, body: JsonObject) {
        sendUnit(HttpMethod.Patch, "api/goals/$id") { jsonBody(body) }
    }

    /** Soft-delete a goal (its history is kept server-side). */
    suspend fun deleteGoal(id: String) {
        sendUnit(HttpMethod.Delete, "api/goals/$id")
    }

    // ---- goal <-> calendar bridge ----------------------------------------------

    /** Confirmed links awaiting review, household-wide. */
    suspend fun recap(): List<GoalRecapItem> =
        send<RecapEnvelope>(HttpMethod.Get, "api/goal-calendar/recap").items

    /** Untagged events that might count toward a goal, household-wide. */
    suspend fun suggestions(): List<GoalSuggestionItem> =
        send<SuggestEnvelope>(HttpMethod.Get, "api/goal-calendar/suggestions").items

    /**
     * Confirm a linked event, logging [amount] to [personIds] (a checklist goal ticks its
     * step and ignores the amount).
     *
     * **Idempotent on (event, occurrence, goal)** server-side, so a replay — a retried
     * request, a double-tap that slipped the busy guard — never double-counts.
     */
    suspend fun confirmRecap(
        eventId: String,
        occurrenceDate: String,
        amount: Double,
        personIds: List<String> = emptyList(),
        note: String? = null,
    ) {
        val body = buildJsonObject {
            put("eventId", eventId)
            put("occurrenceDate", occurrenceDate)
            put("amount", amount)
            if (personIds.isNotEmpty()) put("personIds", stringArray(personIds))
            note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it) }
        }
        sendUnit(HttpMethod.Post, "api/goal-calendar/recap/confirm") { jsonBody(body) }
    }

    /** Mark a linked event as "didn't happen" — clears it without logging progress. */
    suspend fun skipRecap(eventId: String, occurrenceDate: String) {
        sendUnit(HttpMethod.Post, "api/goal-calendar/recap/skip") {
            jsonBody(
                buildJsonObject {
                    put("eventId", eventId)
                    put("occurrenceDate", occurrenceDate)
                },
            )
        }
    }

    /** Tag a suggested event to the goal; it later surfaces in the recap queue. */
    suspend fun linkSuggestion(eventId: String, goalId: String) {
        sendUnit(HttpMethod.Post, "api/goal-calendar/suggestions/link") {
            jsonBody(
                buildJsonObject {
                    put("eventId", eventId)
                    put("goalId", goalId)
                },
            )
        }
    }

    /** Permanently dismiss a suggestion for this household. */
    suspend fun dismissSuggestion(eventId: String) {
        sendUnit(HttpMethod.Post, "api/goal-calendar/suggestions/dismiss") {
            jsonBody(buildJsonObject { put("eventId", eventId) })
        }
    }

    /** A live single-event match for the event editor's "looks like this counts" hint. */
    suspend fun suggestOne(title: String, participantIds: List<String> = emptyList()): GoalSuggestOne? =
        send<SuggestOneEnvelope>(HttpMethod.Post, "api/goal-calendar/suggest-one") {
            jsonBody(
                buildJsonObject {
                    put("title", title)
                    if (participantIds.isNotEmpty()) put("participantIds", stringArray(participantIds))
                },
            )
        }.suggestion

    // ---- the request helper every feature slice copies --------------------------

    private suspend inline fun <reified T> send(
        method: HttpMethod,
        path: String,
        noinline configure: HttpRequestBuilder.() -> Unit = {},
    ): T = execute(method, path, configure) { it.body<T>() }

    /** As [send], for a response with no body worth decoding (a 204, or a bare `{}`). */
    private suspend fun sendUnit(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit = {},
    ) {
        execute(method, path, configure) { }
    }

    private suspend fun <T> execute(
        method: HttpMethod,
        path: String,
        configure: HttpRequestBuilder.() -> Unit,
        parse: suspend (HttpResponse) -> T,
    ): T = withContext(Dispatchers.IO) {
        val sentToken = tokens.accessToken()

        suspend fun attempt(token: String?): HttpResponse = client.request(path) {
            this.method = method
            if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
            configure()
        }

        WaffledHttp.unwrap(
            response = attempt(sentToken),
            tokens = tokens,
            sentToken = sentToken,
            retry = { fresh -> attempt(fresh) },
            parse = parse,
        )
    }
}

private fun stringArray(values: List<String>) = buildJsonArray {
    values.forEach { add(JsonPrimitive(it)) }
}

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
