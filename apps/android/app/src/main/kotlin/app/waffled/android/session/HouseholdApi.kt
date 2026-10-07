package app.waffled.android.session

import app.waffled.core.model.Person
import app.waffled.core.network.TokenProvider
import app.waffled.core.network.WaffledHttp
import app.waffled.core.sync.ModuleGate
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.http.HttpMethod
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

/**
 * The shell's own REST reads: who is signed in and which modules are on. The twin of iOS
 * `WaffledAPI.currentPerson()` + `householdModules()`, which both read `GET /api/household`.
 *
 * Owned by `app` because identity is app-wide — no feature module should carry it.
 */
class HouseholdApi(
    private val client: HttpClient,
    private val tokens: TokenProvider,
) {

    /** What one `/api/household` read tells the shell. */
    data class Identity(
        /** Null for an account that has no household person yet. */
        val person: Person?,
        val modules: ModuleGate,
        /** `settings.chores.rewards` — the spend half of chores; default on. */
        val rewardsEnabled: Boolean,
        val timezone: String?,
        val weekStart: String?,
    )

    @Serializable private data class Envelope(
        val provisioned: Boolean = false,
        val household: HouseholdDTO? = null,
        val person: Person? = null,
    )

    @Serializable private data class HouseholdDTO(
        val timezone: String? = null,
        val weekStart: String? = null,
        val settings: Settings? = null,
    )

    @Serializable private data class Settings(
        val modules: Map<String, Boolean>? = null,
        val chores: Chores? = null,
    )

    @Serializable private data class Chores(val rewards: Boolean? = null)

    @Serializable private data class PersonsEnvelope(val persons: List<Person> = emptyList())

    suspend fun identity(): Identity {
        val env = get<Envelope>("api/household")
        val settings = env.household?.settings
        return Identity(
            person = env.person,
            modules = ModuleGate.fromServer(settings?.modules.orEmpty()),
            rewardsEnabled = settings?.chores?.rewards ?: true,
            timezone = env.household?.timezone,
            weekStart = env.household?.weekStart,
        )
    }

    /** The household roster over REST — the fallback while PowerSync hasn't delivered it. */
    suspend fun persons(): List<Person> = get<PersonsEnvelope>("api/persons").persons

    private suspend inline fun <reified T> get(path: String): T = withContext(Dispatchers.IO) {
        WaffledHttp.authorized(client, tokens, HttpMethod.Get, path) { it.body<T>() }
    }
}
