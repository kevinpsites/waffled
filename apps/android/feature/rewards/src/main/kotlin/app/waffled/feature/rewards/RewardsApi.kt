package app.waffled.feature.rewards

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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The rewards slice of the API — the Kotlin port of the `rewards` / `redemptions` /
 * `balances` / `currencies` / `conversions` endpoints in
 * `apps/ios/.../Sync/WaffledAPI.swift`.
 *
 * **The architecture this models, because it is easy to get wrong:** there is ONE
 * earning ledger per person per currency, presented four ways (a coin chip, a wallet
 * hero, a progress bar, a jar). The "jar" is a *visualisation of saving toward a
 * reward*, not a second balance — `savingToward.have` is the same number
 * `balances[currency]` reports. Chores credit that ledger; goals are intrinsic and
 * never pay out. Modelling these as separate balances is the bug to avoid.
 *
 * Amounts are whole units of a household currency (stars, sticks) and every field the
 * server sends is an `Int`. Keep the arithmetic in [RewardsMath], which stays integer
 * all the way to the draw call.
 *
 * Deliberately **not** a god-object client: each feature module owns the slice it calls.
 * Everything shared (the Ktor client, the 401 refresh, error text) lives in
 * `core:network`.
 */
class RewardsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types ------------------------------------------------------------

    /** A household reward currency (stars, sticks, …) — symbol/label/colour for display. */
    @Serializable
    data class Currency(
        val key: String,
        val label: String = "",
        val symbol: String = "",
        /** The currency's own `#RRGGBB`; parse with `colorFromHex`, fall back to gold. */
        val color: String? = null,
        val isDefault: Boolean = false,
        /** Non-spendable currencies track effort but can't price a reward. */
        val spendable: Boolean = true,
        val sortOrder: Int = 0,
    )

    /** One reward in the household catalog — costs [cost] of [currency]. */
    @Serializable
    data class Reward(
        val id: String,
        val title: String = "",
        val emoji: String? = null,
        val cost: Int = 0,
        val currency: String = "",
        /** Reward-shop category (treats/screen/…); null renders under Other. */
        val category: String? = null,
        val sortOrder: Int = 0,
        /** Per-reward parent-approval gate, seeded from the household default. */
        val requiresApproval: Boolean = false,
    )

    /**
     * A redemption: request → pending → approved/denied. Carries the requesting person's
     * display info plus a snapshot of the reward as it was when they asked, so an edit
     * to the catalog can't rewrite history in the approvals queue.
     */
    @Serializable
    data class RewardRedemption(
        val id: String,
        val rewardId: String = "",
        val personId: String = "",
        val personName: String? = null,
        val personAvatar: String? = null,
        val personColor: String? = null,
        val title: String = "",
        val emoji: String? = null,
        val cost: Int = 0,
        val currency: String = "",
        /** pending | approved | denied */
        val status: String = "pending",
        val decidedAt: String? = null,
        val createdAt: String = "",
    )

    /** One person's balances across every currency, plus recent ledger activity. */
    @Serializable
    data class PersonBalance(
        val personId: String,
        val name: String? = null,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
        /** Back-compat: the balance in the default currency. Prefer [balances]. */
        val stars: Int = 0,
        val balances: List<CurrencyBalance> = emptyList(),
        val recent: List<LedgerLine> = emptyList(),
    ) {
        @Serializable
        data class CurrencyBalance(val currency: String, val balance: Int = 0)

        /** One entry in the single earning ledger — a credit or a debit. */
        @Serializable
        data class LedgerLine(
            val amount: Int = 0,
            val reason: String = "",
            val currency: String = "",
            val createdAt: String = "",
        )
    }

    /** The household reward-economy snapshot: currency catalog + everyone's balances. */
    @Serializable
    data class BalancesSummary(
        val currencies: List<Currency> = emptyList(),
        val people: List<PersonBalance> = emptyList(),
    )

    /** The household reward-approval default a new reward's toggle starts from. */
    @Serializable
    data class RewardSettings(val requireApproval: Boolean = true)

    /** A trade rate between two currencies (e.g. 10 ⭐ → 1 🥢). */
    @Serializable
    data class Conversion(
        val id: String,
        val fromCurrency: String = "",
        val toCurrency: String = "",
        val fromAmount: Int = 0,
        val toAmount: Int = 0,
        val from: Side = Side(),
        val to: Side = Side(),
    ) {
        @Serializable
        data class Side(
            val key: String = "",
            val label: String? = null,
            val symbol: String? = null,
            val color: String? = null,
        )
    }

    /** `ok: false` (with a reason) is how an unaffordable trade comes back — not a 4xx. */
    @Serializable
    data class ConversionResult(val ok: Boolean = false, val error: String? = null)

    /**
     * The **reward slice** of `GET /api/persons/:id/overview`.
     *
     * That route also returns goals, streaks, insights and the ledger — all of which
     * belong to the Family module. `WaffledJson` ignores unknown keys, so decoding only
     * what the shop needs keeps the two modules from fighting over one wire type.
     */
    @Serializable
    data class PersonRewardOverview(
        val currencies: List<Currency> = emptyList(),
        val balances: List<PersonBalance.CurrencyBalance> = emptyList(),
        /** The reward this person is pinned to — drives the saving-toward hero. */
        val savingToward: SavingToward? = null,
        /** The catalog annotated with this person's progress, for the picker. */
        val rewardShop: List<ShopReward> = emptyList(),
    ) {
        /**
         * Note [have] is not a separate wallet: it is the person's balance in [currency],
         * the same number `/api/balances` reports. The jar just draws it against [cost].
         */
        @Serializable
        data class SavingToward(
            val id: String,
            val title: String = "",
            val emoji: String? = null,
            val cost: Int = 0,
            val have: Int = 0,
            val toGo: Int = 0,
            val pct: Int = 0,
            val currency: String = "",
        )

        @Serializable
        data class ShopReward(
            val id: String,
            val title: String = "",
            val emoji: String? = null,
            val cost: Int = 0,
            val have: Int = 0,
            val toGo: Int = 0,
            val currency: String = "",
        )
    }

    @Serializable private data class RewardListEnvelope(val rewards: List<Reward> = emptyList())
    @Serializable private data class RewardEnvelope(val reward: Reward)
    @Serializable private data class RedemptionListEnvelope(val redemptions: List<RewardRedemption> = emptyList())
    @Serializable private data class RedemptionEnvelope(val redemption: RewardRedemption)
    @Serializable private data class CurrencyListEnvelope(val currencies: List<Currency> = emptyList())
    @Serializable private data class ConversionListEnvelope(val conversions: List<Conversion> = emptyList())

    // ---- catalog ---------------------------------------------------------------

    /** The active rewards catalog. */
    suspend fun catalog(): List<Reward> =
        send<RewardListEnvelope>(HttpMethod.Get, "api/rewards").rewards

    /** Archived (soft-deleted) rewards — `reward.manage` only, so callers treat a 403 as empty. */
    suspend fun archivedRewards(): List<Reward> =
        send<RewardListEnvelope>(HttpMethod.Get, "api/rewards/archived").rewards

    /**
     * Create a reward.
     *
     * The body is built as a [JsonObject] rather than a data class because `WaffledJson`
     * sets `explicitNulls = false`: a nullable property would be *omitted*, and "no
     * emoji" / "no category" would silently mean "leave it alone" on the PATCH twin
     * below. Both keys must reach the server as an explicit null.
     */
    suspend fun createReward(
        title: String,
        emoji: String?,
        cost: Int,
        currency: String,
        category: String?,
        requiresApproval: Boolean,
    ): Reward = send<RewardEnvelope>(HttpMethod.Post, "api/rewards") {
        jsonBody(rewardBody(title, emoji, cost, currency, category, requiresApproval))
    }.reward

    /** Edit a reward. Same explicit-null contract as [createReward]. */
    suspend fun updateReward(
        id: String,
        title: String,
        emoji: String?,
        cost: Int,
        currency: String,
        category: String?,
        requiresApproval: Boolean,
    ): Reward = send<RewardEnvelope>(HttpMethod.Patch, "api/rewards/$id") {
        jsonBody(rewardBody(title, emoji, cost, currency, category, requiresApproval))
    }.reward

    private fun rewardBody(
        title: String,
        emoji: String?,
        cost: Int,
        currency: String,
        category: String?,
        requiresApproval: Boolean,
    ): JsonObject = buildJsonObject {
        put("title", title)
        put("cost", cost)
        put("currency", currency)
        put("requiresApproval", requiresApproval)
        put("emoji", emoji?.let(::JsonPrimitive) ?: JsonNull)
        put("category", category?.let(::JsonPrimitive) ?: JsonNull)
    }

    /** Soft-archive a reward; its redemption history is kept. Answers 204. */
    suspend fun archiveReward(id: String) {
        sendUnit(HttpMethod.Delete, "api/rewards/$id")
    }

    /** Restore an archived reward. */
    suspend fun restoreReward(id: String): Reward =
        send<RewardEnvelope>(HttpMethod.Post, "api/rewards/$id/restore").reward

    /** The household's reward-approval default (Settings → Chores & rewards). */
    suspend fun rewardSettings(): RewardSettings =
        send(HttpMethod.Get, "api/rewards/settings")

    // ---- balances + currencies -------------------------------------------------

    /** Per-person, per-currency balances for the whole household. */
    suspend fun balances(): BalancesSummary = send(HttpMethod.Get, "api/balances")

    /** The household's currency catalog on its own (without the balances payload). */
    suspend fun currencies(): List<Currency> =
        send<CurrencyListEnvelope>(HttpMethod.Get, "api/currencies").currencies

    /** One person's reward overview — the saving-toward pin and their shop progress. */
    suspend fun personOverview(personId: String): PersonRewardOverview =
        send(HttpMethod.Get, "api/persons/$personId/overview")

    // ---- redemptions -----------------------------------------------------------

    /** Redemptions, optionally filtered by status (pending | approved | denied). */
    suspend fun redemptions(status: String? = null): List<RewardRedemption> {
        val path = if (status.isNullOrBlank()) "api/redemptions" else "api/redemptions?status=$status"
        return send<RedemptionListEnvelope>(HttpMethod.Get, path).redemptions
    }

    /**
     * Request a reward for a person.
     *
     * Whether this debits immediately or files a pending request is the SERVER's call
     * (the reward's `requiresApproval` plus the household default) — the client reads
     * `status` off the response rather than predicting it.
     */
    suspend fun redeem(rewardId: String, personId: String): RewardRedemption =
        send<RedemptionEnvelope>(HttpMethod.Post, "api/rewards/$rewardId/redeem") {
            jsonBody(buildJsonObject { put("personId", personId) })
        }.redemption

    /** Approve a pending redemption — this is what writes the debit ledger entry. */
    suspend fun approveRedemption(id: String): RewardRedemption =
        send<RedemptionEnvelope>(HttpMethod.Post, "api/redemptions/$id/approve").redemption

    /** Deny a pending redemption — the balance is left untouched. */
    suspend fun denyRedemption(id: String): RewardRedemption =
        send<RedemptionEnvelope>(HttpMethod.Post, "api/redemptions/$id/deny").redemption

    // ---- ad-hoc awards + saving toward -----------------------------------------

    /**
     * Hand a person stars on the spot (not tied to a chore) — a positive `spot_award`
     * entry in the same one ledger, which also advances their saving-toward jar.
     *
     * A blank currency or note is omitted entirely rather than sent as `""`: the server
     * treats a missing currency as "the household default", and an empty note would
     * render as a trailing em dash on the ledger row.
     */
    suspend fun awardSpot(personId: String, amount: Int, currency: String?, note: String?) {
        val body = buildJsonObject {
            put("amount", amount)
            currency?.takeIf { it.isNotBlank() }?.let { put("currency", it) }
            note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it) }
        }
        sendUnit(HttpMethod.Post, "api/persons/$personId/award") { jsonBody(body) }
    }

    /**
     * Pin the reward a person is saving toward — or **clear** it with a null [rewardId].
     *
     * Clearing depends on `rewardId` arriving as an explicit JSON null; omit the key and
     * the old pin simply stays, which looks exactly like a broken button.
     */
    suspend fun setSavingToward(personId: String, rewardId: String?) {
        val body = buildJsonObject {
            put("rewardId", rewardId?.let(::JsonPrimitive) ?: JsonNull)
        }
        sendUnit(HttpMethod.Post, "api/persons/$personId/saving-toward") { jsonBody(body) }
    }

    // ---- conversions -----------------------------------------------------------

    /**
     * The household's trade rates.
     *
     * Ported so the Family module's trade sheet has a slice to call; the rewards shop
     * itself deliberately shows no trade affordance yet (see [RewardsMath.maxTrades] for
     * the integer arithmetic a trade UI needs).
     */
    suspend fun conversions(): List<Conversion> =
        send<ConversionListEnvelope>(HttpMethod.Get, "api/conversions").conversions

    /** Apply a trade rate to a person's balance N times. `ok: false` = insufficient funds. */
    suspend fun applyConversion(id: String, personId: String, times: Int): ConversionResult =
        send(HttpMethod.Post, "api/conversions/$id/apply") {
            jsonBody(
                buildJsonObject {
                    put("personId", personId)
                    put("times", times)
                },
            )
        }

    // ---- the request helper every feature slice copies --------------------------

    /**
     * Build → authorise → send → unwrap, in one place.
     *
     *  - the bearer token is attached per request (it rotates, so it can't be baked into
     *    the client's `defaultRequest`);
     *  - the token that was actually sent is handed to [WaffledHttp.unwrap], which makes
     *    a **staggered** 401 cheap — a caller that is merely behind gets the current
     *    token instead of triggering a second refresh;
     *  - [WaffledHttp.unwrap] replays once after a refresh and turns a non-2xx into a
     *    `WaffledApiException` carrying the SERVER's message.
     */
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

/** Attach a pre-built JSON tree as the request body. */
private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
