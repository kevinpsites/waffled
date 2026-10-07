package app.waffled.feature.settings

import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
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
 * The settings slice of the API: household + members, multi-household switching,
 * modules, the permissions matrix, currencies/conversions, reward + photo-proof policy,
 * and the server update check. Port of the matching calls in iOS `WaffledAPI.swift`.
 */
class SettingsApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    // ---- wire types: household ---------------------------------------------------

    /**
     * `GET /api/household` — one read carries the switcher (memberships, invites), the
     * signed-in person, and the settings jsonb (modules, rewards sub-flag, display).
     * Every list defaults to empty: a kiosk/device body omits them.
     */
    @Serializable
    data class HouseholdOverview(
        val household: Ref? = null,
        val person: CurrentPerson? = null,
        val memberships: List<Membership> = emptyList(),
        val pendingInvites: List<PendingInvite> = emptyList(),
    ) {
        @Serializable
        data class Ref(val id: String, val name: String = "", val settings: RawSettings? = null)

        @Serializable
        data class RawSettings(
            val modules: Map<String, Boolean>? = null,
            val chores: Chores? = null,
            val display: Display? = null,
        ) {
            @Serializable data class Chores(val rewards: Boolean? = null)

            @Serializable data class Display(val eventStyle: String? = null, val familyColorHex: String? = null)
        }

        fun modules(): HouseholdModules {
            val s = household?.settings
            return HouseholdModules(
                modules = s?.modules.orEmpty(),
                rewards = s?.chores?.rewards ?: true,
                eventStyle = s?.display?.eventStyle,
                familyColorHex = s?.display?.familyColorHex,
            )
        }
    }

    /** Least privilege when a field is absent — the server is the real gate. */
    @Serializable
    data class CurrentPerson(
        val id: String,
        val memberType: String = "",
        val isAdmin: Boolean = false,
        val capabilities: List<String> = emptyList(),
    )

    @Serializable
    data class Membership(
        val householdId: String,
        val householdName: String = "",
        val personId: String = "",
        val isAdmin: Boolean = false,
        val memberType: String = "",
    )

    @Serializable
    data class PendingInvite(
        val id: String,
        val householdName: String = "",
        val memberType: String = "",
        val isAdmin: Boolean = false,
    )

    @Serializable
    data class SwitchResult(
        val accessToken: String,
        val refreshToken: String,
        val expiresIn: Int? = null,
        val householdId: String = "",
    )

    data class HouseholdModules(
        val modules: Map<String, Boolean>,
        val rewards: Boolean,
        val eventStyle: String? = null,
        val familyColorHex: String? = null,
    )

    @Serializable
    data class HouseholdSettings(val household: Household, val members: List<Member> = emptyList())

    @Serializable
    data class Household(
        val id: String,
        val name: String = "",
        val timezone: String = "",
        val weekStart: String = "sunday",
        val location: String? = null,
        val ownerPersonId: String? = null,
    )

    @Serializable
    data class Member(
        val id: String,
        val name: String,
        val memberType: String = "adult",
        val isAdmin: Boolean = false,
        val avatarEmoji: String? = null,
        val colorHex: String? = null,
        val birthday: String? = null,
        val dietaryNotes: String? = null,
        val showOnKiosk: Boolean = true,
        val hasLogin: Boolean = false,
        val loginEmail: String? = null,
        val hasPassword: Boolean = false,
        val hasPin: Boolean = false,
        val isOwner: Boolean = false,
    )

    /** A null [avatarEmoji] CLEARS it (sent as an explicit null); a null [birthday] is left out. */
    data class PersonDraft(
        val name: String,
        val memberType: String,
        val colorHex: String,
        val isAdmin: Boolean,
        val showOnKiosk: Boolean,
        val avatarEmoji: String?,
        val birthday: String?,
    )

    // ---- wire types: rewards economy ---------------------------------------------

    @Serializable
    data class Currency(
        val key: String,
        val label: String = "",
        val symbol: String = "",
        val color: String? = null,
        val isDefault: Boolean = false,
        val spendable: Boolean = true,
        val sortOrder: Int = 0,
    )

    /** A blank [symbol] is sent as an explicit null so the server falls back to its default. */
    data class CurrencyDraft(
        val label: String,
        val symbol: String,
        val color: String,
        val isDefault: Boolean,
        val spendable: Boolean,
    )

    @Serializable
    data class Conversion(
        val id: String,
        val fromCurrency: String,
        val toCurrency: String,
        val fromAmount: Int = 1,
        val toAmount: Int = 1,
        val from: Side = Side(""),
        val to: Side = Side(""),
    ) {
        @Serializable
        data class Side(
            val key: String,
            val label: String? = null,
            val symbol: String? = null,
            val color: String? = null,
        )
    }

    @Serializable
    data class StoredProof(
        val instanceId: String,
        val choreTitle: String = "",
        val emoji: String? = null,
        val personName: String? = null,
        val personAvatar: String? = null,
        val personColor: String? = null,
        val proofUrl: String? = null,
        val completedAt: String? = null,
    )

    @Serializable
    data class UpdateInfo(
        val enabled: Boolean = false,
        val current: Current,
        val latest: Release? = null,
        val updateAvailable: Boolean? = null,
        val checkedAt: String? = null,
    ) {
        @Serializable data class Release(val tag: String, val url: String, val publishedAt: String? = null)

        @Serializable data class Current(val version: String, val sha: String? = null)
    }

    // ---- envelopes ----------------------------------------------------------------

    @Serializable private data class ModulesEnvelope(val modules: Map<String, Boolean> = emptyMap())

    @Serializable private data class RewardsFlag(val rewards: Boolean? = null)

    @Serializable private data class PermissionsEnvelope(val permissions: Map<String, Map<String, Boolean>> = emptyMap())

    @Serializable private data class CurrenciesEnvelope(val currencies: List<Currency> = emptyList())

    @Serializable private data class ConversionsEnvelope(val conversions: List<Conversion> = emptyList())

    @Serializable private data class RewardSettings(val requireApproval: Boolean = true)

    @Serializable private data class ChoresSettings(val proofTtlDays: Int = 3)

    @Serializable private data class ProofsEnvelope(val proofs: List<StoredProof> = emptyList())

    @Serializable private data class Cleared(val cleared: Int = 0)

    // ---- household & account -------------------------------------------------------

    suspend fun household(): HouseholdOverview = get("api/household")

    suspend fun householdSettings(): HouseholdSettings = get("api/household/settings")

    /** Mints a pair whose token carries the TARGET household; the caller must adopt it. */
    suspend fun switchHousehold(householdId: String): SwitchResult =
        send(HttpMethod.Post, "api/auth/switch", buildJsonObject { put("householdId", householdId) })

    /** Creates the membership; does NOT switch into it. */
    suspend fun acceptInvite(id: String) =
        sendUnit(HttpMethod.Post, "api/auth/invites/$id/accept", JsonObject(emptyMap()))

    /** Not admin-gated — how a teen or kid picks their own calendar colour. */
    suspend fun updateOwnColor(hex: String) =
        sendUnit(HttpMethod.Put, "api/account/profile", buildJsonObject { put("colorHex", hex) })

    /** Edit one of name / timezone / weekStart / location (admins). */
    suspend fun updateHousehold(field: String, value: String) =
        sendUnit(HttpMethod.Patch, "api/household", buildJsonObject { put(field, value) })

    /** Merges into `settings.display`; only the fields given are sent. */
    suspend fun setHouseholdDisplay(eventStyle: String? = null, familyColorHex: String? = null) {
        val body = buildJsonObject {
            eventStyle?.let { put("eventStyle", it) }
            familyColorHex?.let { put("familyColorHex", it) }
        }
        if (body.isEmpty()) return
        sendUnit(HttpMethod.Patch, "api/household/display", body)
    }

    // ---- modules ---------------------------------------------------------------------

    /** Returns the merged flag map. The server rejects non-catalog and planned keys. */
    suspend fun setModules(patch: Map<String, Boolean>): Map<String, Boolean> =
        send<ModulesEnvelope>(
            HttpMethod.Patch,
            "api/household/modules",
            JsonObject(patch.mapValues { JsonPrimitive(it.value) }),
        ).modules

    suspend fun setChoresRewards(on: Boolean): Boolean =
        send<RewardsFlag>(HttpMethod.Put, "api/chores/settings", buildJsonObject { put("rewards", on) }).rewards ?: true

    // ---- members ---------------------------------------------------------------------

    suspend fun savePerson(id: String?, draft: PersonDraft) {
        val body = buildJsonObject {
            put("name", draft.name)
            put("memberType", draft.memberType)
            put("colorHex", draft.colorHex)
            put("isAdmin", draft.isAdmin)
            put("showOnKiosk", draft.showOnKiosk)
            put("avatarEmoji", draft.avatarEmoji?.let(::JsonPrimitive) ?: JsonNull)
            draft.birthday?.let { put("birthday", it) }
        }
        if (id == null) sendUnit(HttpMethod.Post, "api/persons", body)
        else sendUnit(HttpMethod.Patch, "api/persons/$id", body)
    }

    suspend fun deletePerson(id: String) = sendUnit(HttpMethod.Delete, "api/persons/$id")

    /** A blank password invites SSO-only. 409 when the email is taken. */
    suspend fun setPersonLogin(id: String, email: String, password: String?) {
        val body = buildJsonObject {
            put("email", email)
            if (!password.isNullOrEmpty()) put("password", password)
        }
        sendUnit(HttpMethod.Put, "api/persons/$id/login", body)
    }

    suspend fun removePersonLogin(id: String) = sendUnit(HttpMethod.Delete, "api/persons/$id/login")

    suspend fun setPersonPin(id: String, pin: String) =
        sendUnit(HttpMethod.Put, "api/persons/$id/pin", buildJsonObject { put("pin", pin) })

    suspend fun clearPersonPin(id: String) = sendUnit(HttpMethod.Delete, "api/persons/$id/pin")

    // ---- permissions -----------------------------------------------------------------

    /** Admin-only; everyone else gets a 403. */
    suspend fun permissionsMatrix(): Map<String, Map<String, Boolean>> =
        get<PermissionsEnvelope>("api/permissions").permissions

    /** Saves the whole matrix and returns the sanitised one the server stored. */
    suspend fun setPermissionsMatrix(matrix: Map<String, Map<String, Boolean>>): Map<String, Map<String, Boolean>> {
        val body = buildJsonObject {
            put(
                "permissions",
                JsonObject(matrix.mapValues { (_, row) -> JsonObject(row.mapValues { JsonPrimitive(it.value) }) }),
            )
        }
        return send<PermissionsEnvelope>(HttpMethod.Put, "api/permissions", body).permissions
    }

    // ---- currencies & conversions ------------------------------------------------------

    suspend fun currencies(): List<Currency> = get<CurrenciesEnvelope>("api/currencies").currencies

    /** [key] null creates; otherwise edits (the key itself is immutable). */
    suspend fun saveCurrency(key: String?, draft: CurrencyDraft) {
        val body = buildJsonObject {
            put("label", draft.label.trim())
            put("symbol", draft.symbol.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
            put("color", draft.color)
            put("isDefault", draft.isDefault)
            put("spendable", draft.spendable)
        }
        if (key == null) sendUnit(HttpMethod.Post, "api/currencies", body)
        else sendUnit(HttpMethod.Patch, "api/currencies/$key", body)
    }

    /** Refused for the default or the last currency. */
    suspend fun deleteCurrency(key: String) = sendUnit(HttpMethod.Delete, "api/currencies/$key")

    suspend fun conversions(): List<Conversion> = get<ConversionsEnvelope>("api/conversions").conversions

    suspend fun createConversion(from: String, to: String, fromAmount: Int, toAmount: Int) {
        val body = buildJsonObject {
            put("fromCurrency", from)
            put("toCurrency", to)
            put("fromAmount", maxOf(1, fromAmount))
            put("toAmount", maxOf(1, toAmount))
        }
        sendUnit(HttpMethod.Post, "api/conversions", body)
    }

    suspend fun deleteConversion(id: String) = sendUnit(HttpMethod.Delete, "api/conversions/$id")

    // ---- reward + chore policy ---------------------------------------------------------

    suspend fun rewardApprovalRequired(): Boolean = get<RewardSettings>("api/rewards/settings").requireApproval

    suspend fun setRewardApproval(required: Boolean) =
        sendUnit(HttpMethod.Put, "api/rewards/settings", buildJsonObject { put("requireApproval", required) })

    /** Days a completed-chore photo is kept; 0 = until deleted. */
    suspend fun proofTtlDays(): Int = get<ChoresSettings>("api/chores/settings").proofTtlDays

    /** Returns the saved value — the server clamps to 0…365. */
    suspend fun setProofTtlDays(days: Int): Int =
        send<ChoresSettings>(HttpMethod.Put, "api/chores/settings", buildJsonObject { put("proofTtlDays", days) }).proofTtlDays

    suspend fun storedProofs(): List<StoredProof> = get<ProofsEnvelope>("api/chore-proofs").proofs

    suspend fun deleteProof(instanceId: String) = sendUnit(HttpMethod.Delete, "api/chore-proofs/$instanceId")

    suspend fun clearProofs(): Int =
        send<Cleared>(HttpMethod.Delete, "api/chore-proofs", JsonObject(emptyMap())).cleared

    // ---- updates -----------------------------------------------------------------------

    /** Admin-gated; `current` is always present, so it also answers "which build am I on?". */
    suspend fun updates(): UpdateInfo = get("api/updates")

    // ---- plumbing ----------------------------------------------------------------------

    private suspend inline fun <reified T> get(path: String): T =
        execute(HttpMethod.Get, path, {}) { it.body<T>() }

    private suspend inline fun <reified T> send(method: HttpMethod, path: String, body: JsonObject): T =
        execute(method, path, { jsonBody(body) }) { it.body<T>() }

    private suspend fun sendUnit(method: HttpMethod, path: String, body: JsonObject? = null) {
        execute(method, path, { if (body != null) jsonBody(body) }) { }
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

    companion object {
        /**
         * Is anything answering at [baseUrl]? Returns the HTTP status (a 401 still proves
         * the API is there — `/api/health` needs auth), or null on a transport failure.
         * Uses a throwaway, token-less client so it can test an address before saving it.
         */
        suspend fun probeHealth(baseUrl: String): Int? = withContext(Dispatchers.IO) {
            val probe = WaffledHttp.client(
                tokens = NoTokens,
                server = object : ServerAddressProvider {
                    override fun baseUrl(): String = baseUrl
                },
            )
            try {
                probe.get("api/health").status.value
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            } finally {
                probe.close()
            }
        }

        private object NoTokens : TokenProvider {
            override suspend fun accessToken(): String? = null
            override suspend fun refreshAccessToken(failedToken: String?): String? = null
        }
    }
}

private fun HttpRequestBuilder.jsonBody(body: JsonObject) {
    contentType(ContentType.Application.Json)
    setBody(body)
}
