package app.waffled.android

import android.content.Context
import android.content.SharedPreferences
import app.waffled.core.auth.AuthApi
import app.waffled.core.auth.EncryptedTokenStore
import app.waffled.core.auth.KtorRefreshBackend
import app.waffled.core.auth.TokenRefresher
import app.waffled.core.auth.WaffledAuth
import app.waffled.core.auth.KeyValueStore
import app.waffled.core.auth.KeystoreTokenCrypto
import app.waffled.core.auth.TokenStore
import app.waffled.core.design.ThemePrefsStore
import app.waffled.core.design.ThemeStore
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.ServerAddressProvider
import app.waffled.core.network.ServerUrl
import app.waffled.core.network.ServerUrlVerdict
import app.waffled.core.network.WaffledHttp
import app.waffled.core.sync.KtorSyncBackend
import app.waffled.core.sync.SyncManager
import app.waffled.core.sync.WaffledConnector
import app.waffled.feature.calendar.CalendarApi
import app.waffled.feature.calendar.CalendarModel
import app.waffled.feature.calendar.CountdownsModel
import app.waffled.feature.chores.ChoresApi
import app.waffled.feature.chores.ChoresModel
import app.waffled.feature.lists.ListsApi
import app.waffled.feature.lists.ListsIndexModel
import app.waffled.feature.photos.PhotosApi
import app.waffled.feature.photos.PhotosModel
import app.waffled.feature.rewards.RewardsApi
import app.waffled.feature.rewards.RewardsModel
import app.waffled.android.session.HouseholdApi
import app.waffled.android.session.IdentityStore
import app.waffled.feature.goals.GoalsApi
import app.waffled.feature.goals.GoalsModel
import app.waffled.feature.lists.TodayListModel
import app.waffled.feature.meals.MealsApi
import app.waffled.feature.meals.MonthPlannerModel
import app.waffled.feature.meals.WeekPlannerModel
import app.waffled.feature.pantry.PantryApi
import app.waffled.feature.pantry.PantryModel
import app.waffled.feature.recipes.CookApi
import app.waffled.feature.recipes.CookSessionStore
import app.waffled.feature.recipes.CookTimerAlarm
import app.waffled.feature.recipes.RecipesApi
import app.waffled.feature.recipes.RecipesModel
import app.waffled.feature.recipes.SharedPrefsCookStateStore
import app.waffled.feature.today.DashboardModel
import app.waffled.feature.today.TodayApi
import app.waffled.feature.today.TodayLayoutModel
import io.ktor.client.HttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Hand-rolled dependency container.
 *
 * Deliberately not Hilt: KSP's newest release lags Kotlin 2.4.10, and annotation
 * processors are exactly what breaks on a bleeding-edge Kotlin. This also keeps each
 * feature module's build file trivial, which matters with many parallel agents.
 *
 * Construct once in [WaffledApp] and pass down; feature ViewModels take what they need
 * as constructor arguments.
 */
class AppContainer(context: Context) {

    private val appContext: Context = context.applicationContext

    private val prefs: SharedPreferences =
        context.getSharedPreferences("waffled.prefs", Context.MODE_PRIVATE)

    val themeStore: ThemeStore = ThemeStore(
        object : ThemePrefsStore {
            override fun getString(key: String): String? = prefs.getString(key, null)
            override fun putString(key: String, value: String) {
                prefs.edit().putString(key, value).apply()
            }
        },
    )

    /** Bumped by writers so REST-backed screens know to re-fetch. */
    val refreshBus = RefreshBus()

    /** Long-lived glue (flow → model plumbing) that should live as long as the process. */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Per-device choices — the iOS `@AppStorage` keys, so the meaning matches. */
    val devicePrefs: DevicePrefs = DevicePrefs(prefs)

    val serverAddress: MutableServerAddress = MutableServerAddress(prefs)

    /**
     * Tokens encrypted at rest under a key held in the Android Keystore — the analogue
     * of the iOS Keychain.
     */
    val tokenStore: TokenStore = EncryptedTokenStore(
        prefs = SharedPrefsKeyValueStore(prefs),
        crypto = KeystoreTokenCrypto(),
    )

    /** `/api/auth` — its own bare client; signing in must not itself need a token. */
    val authApi: AuthApi = AuthApi(serverAddress)

    /**
     * The one [app.waffled.core.network.TokenProvider] the app shares. Feature
     * ViewModels take this (or [httpClient]) rather than assembling their own auth.
     */
    val auth: WaffledAuth = WaffledAuth(
        store = tokenStore,
        refresher = TokenRefresher(
            store = tokenStore,
            backend = KtorRefreshBackend(AuthApi.defaultClient(serverAddress)),
        ),
    )

    /** The authenticated client every feature API slice should use. */
    val httpClient: HttpClient by lazy { WaffledHttp.client(auth, serverAddress) }

    /**
     * PowerSync — the five synced tables (Calendar + People). Started once the user is
     * signed in; everything else in the app is REST.
     */
    val syncManager: SyncManager by lazy {
        SyncManager(
            context = context.applicationContext,
            connector = WaffledConnector(KtorSyncBackend(httpClient, auth)),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        )
    }

    /**
     * Photos — the reference feature. One line per feature is the intended shape: build
     * the API slice from the shared client, hand it the base URL and the refresh bus.
     */
    val calendarApi: CalendarApi by lazy { CalendarApi(httpClient, auth) }

    val calendarModel: CalendarModel by lazy {
        CalendarModel(
            eventsByDay = syncManager.eventsByDay,
            scope = appScope,
            syncedWeekStart = syncManager.householdWeekStart,
        ).also { model ->
            // The model takes these as inputs rather than reading SyncManager itself.
            appScope.launch { syncManager.members.collect(model::setMembers) }
            appScope.launch { syncManager.householdZone.collect(model::setZone) }
            appScope.launch { identity.householdWeekStart.collect(model::setRestWeekStart) }
        }
    }

    val countdownsModel: CountdownsModel by lazy { CountdownsModel.backedBy(calendarApi) }

    val listsModel: ListsIndexModel by lazy {
        ListsIndexModel(api = listsApi, refreshBus = refreshBus)
    }

    val choresModel: ChoresModel by lazy {
        ChoresModel(
            api = ChoresApi(httpClient, auth),
            baseUrl = serverAddress.baseUrl(),
            initialDate = java.time.LocalDate.now().toString(),
            refreshBus = refreshBus,
        )
    }

    val rewardsModel: RewardsModel by lazy {
        RewardsModel(
            api = RewardsApi(httpClient, auth),
            refreshBus = refreshBus,
        )
    }

    val photosModel: PhotosModel by lazy {
        PhotosModel(
            api = PhotosApi(httpClient, auth),
            baseUrl = serverAddress.baseUrl(),
            refreshBus = refreshBus,
        )
    }

    // ---- session -----------------------------------------------------------------

    val identity: IdentityStore by lazy {
        IdentityStore(HouseholdApi(httpClient, auth), syncManager, appScope)
    }

    /**
     * Bumped on every deliberate refresh (pull-down, return to foreground) — the iOS
     * `SyncManager.refreshRev`. Self-loading Today cards key their load on it.
     */
    private val _surfaceRev = MutableStateFlow(0)
    val surfaceRev: StateFlow<Int> = _surfaceRev.asStateFlow()

    /** iOS `refreshRestSurfaces()`: wake the self-loading cards, then re-read identity. */
    suspend fun refreshSurfaces() {
        _surfaceRev.value += 1
        identity.load()
        runCatching { calendarApi.householdDisplay() }.getOrNull()?.let(calendarModel::setDisplay)
    }

    // ---- Today -------------------------------------------------------------------

    private val todayApi: TodayApi by lazy { TodayApi(httpClient, auth) }
    val dashboardModel: DashboardModel by lazy { DashboardModel.from(todayApi) }
    val todayLayoutModel: TodayLayoutModel by lazy { TodayLayoutModel(todayApi) }

    val listsApi: ListsApi by lazy { ListsApi(httpClient, auth) }

    val todayListModel: TodayListModel by lazy {
        TodayListModel(
            api = listsApi,
            pinStore = object : TodayListModel.PinStore {
                override fun pinnedListId(): String? = devicePrefs.todayListPick.ifEmpty { null }
                override fun setPinnedListId(id: String) {
                    devicePrefs.todayListPick = id
                }
            },
        )
    }

    // ---- Goals -------------------------------------------------------------------

    val goalsApi: GoalsApi by lazy { GoalsApi(httpClient, auth) }
    val goalsModel: GoalsModel by lazy { GoalsModel(goalsApi, refreshBus) }

    // ---- Meals + Recipes ---------------------------------------------------------

    val mealsApi: MealsApi by lazy { MealsApi(httpClient, auth) }

    /** "Today" for the planners — the household's day, not the device's. */
    private fun householdToday(): LocalDate = LocalDate.now(syncManager.householdZone.value)

    val weekPlannerModel: WeekPlannerModel by lazy {
        WeekPlannerModel(
            api = mealsApi,
            zone = syncManager.householdZone.value,
            firstDay = { identity.householdWeekStart.value },
            refreshBus = refreshBus,
            today = ::householdToday,
        )
    }

    val monthPlannerModel: MonthPlannerModel by lazy {
        MonthPlannerModel(
            api = mealsApi,
            zone = syncManager.householdZone.value,
            firstDay = { identity.householdWeekStart.value },
            refreshBus = refreshBus,
            today = ::householdToday,
        )
    }

    val recipesApi: RecipesApi by lazy { RecipesApi(httpClient, auth) }

    val recipesModel: RecipesModel by lazy {
        RecipesModel(api = recipesApi, baseUrl = serverAddress.baseUrl(), refreshBus = refreshBus)
    }

    /** App-wide, like iOS: one cook session survives navigation and process death. */
    val cookStore: CookSessionStore by lazy {
        CookSessionStore(
            api = CookApi.live(recipesApi),
            alarm = CookTimerAlarm(appContext),
            persistence = SharedPrefsCookStateStore(appContext),
        )
    }

    // ---- Pantry ------------------------------------------------------------------

    val pantryModel: PantryModel by lazy {
        PantryModel(
            api = PantryApi(httpClient, auth),
            baseUrl = serverAddress.baseUrl(),
            zone = syncManager.householdZone.value,
            refreshBus = refreshBus,
            clock = ::householdToday,
        )
    }
}

/** Per-device UI choices, under the same keys iOS keeps in `@AppStorage`. */
class DevicePrefs(private val prefs: SharedPreferences) {

    /** Today chores card: "" = me, "family" = the summary, else a person id. */
    var todayChorePersonId: String
        get() = prefs.getString("waffled.todayChorePersonId", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.todayChorePersonId", value).apply()

    /** Today goal hero: the pinned goal id, "" = automatic. */
    var todayGoalId: String
        get() = prefs.getString("waffled.todayGoalId", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.todayGoalId", value).apply()

    /** Today lists card: the pinned list id. */
    var todayListPick: String
        get() = prefs.getString("waffled.todayListPick", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.todayListPick", value).apply()
}

private class SharedPrefsKeyValueStore(
    private val prefs: SharedPreferences,
) : KeyValueStore {
    override fun getString(key: String): String? = prefs.getString(key, null)
    override fun putString(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}

/** Server address, user-editable at runtime because Waffled is self-hosted. */
class MutableServerAddress(private val prefs: SharedPreferences) : ServerAddressProvider {

    override fun baseUrl(): String =
        prefs.getString(KEY, null) ?: BuildConfig.DEFAULT_SERVER_URL

    /**
     * Validate and store. Returns the verdict so the settings screen can explain a
     * refusal — notably plain HTTP to a public host (see ServerUrl).
     */
    fun set(input: String): ServerUrlVerdict {
        val verdict = ServerUrl.validate(input)
        if (verdict is ServerUrlVerdict.Ok) {
            prefs.edit().putString(KEY, verdict.url).apply()
        }
        return verdict
    }

    private companion object {
        const val KEY = "waffled.serverUrl"
    }
}

