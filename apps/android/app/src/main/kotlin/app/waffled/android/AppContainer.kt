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
import app.waffled.core.auth.TokenPair
import app.waffled.core.auth.TokenStore
import app.waffled.android.auth.SessionPhase
import app.waffled.feature.kiosk.KioskApi
import app.waffled.feature.kiosk.KioskDeviceAuth
import app.waffled.feature.kiosk.KioskDeviceStore
import app.waffled.feature.kiosk.KioskFamilyModel
import app.waffled.feature.kiosk.KioskMode
import app.waffled.feature.kiosk.KioskRailStore
import app.waffled.feature.kiosk.KioskServerAddress
import app.waffled.feature.kiosk.KioskSessionHost
import app.waffled.feature.kiosk.ScreensaverModel
import app.waffled.feature.kioskcalendar.KioskCalendarApi
import app.waffled.feature.kiosktoday.KioskTodayModel
import app.waffled.feature.planning.PlanningEnvironment
import app.waffled.feature.settings.ServerAddressForm
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
import app.waffled.feature.bites.WaffledBitesApi
import app.waffled.feature.capture.CaptureApi
import app.waffled.feature.family.ApprovalsModel
import app.waffled.feature.family.FamilyApi
import app.waffled.feature.family.FamilyHubModel
import app.waffled.feature.familynight.FamilyNightApi
import app.waffled.feature.familynight.FamilyNightModel
import app.waffled.feature.rhythms.RhythmsApi
import app.waffled.feature.rhythms.RhythmsModel
import app.waffled.feature.settings.ServerChange
import app.waffled.feature.settings.ServerConnection
import app.waffled.feature.settings.SettingsApi
import app.waffled.feature.settings.UpdateDismissalStore
import app.waffled.feature.settingshousehold.EventReminders
import app.waffled.feature.settingshousehold.SettingsHouseholdApi
import app.waffled.feature.settingshousehold.create
import java.time.ZoneId
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

    /** Per-device plain prefs — planning's "Leave for now", the kiosk rail, the device pairing. */
    val keyValueStore: KeyValueStore = SharedPrefsKeyValueStore(prefs)

    /**
     * Tokens encrypted at rest under a key held in the Android Keystore — the analogue
     * of the iOS Keychain.
     */
    val tokenStore: TokenStore = EncryptedTokenStore(
        prefs = keyValueStore,
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

    val rewardsApi: RewardsApi by lazy { RewardsApi(httpClient, auth) }

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
            api = rewardsApi,
            refreshBus = refreshBus,
        )
    }

    val photosApi: PhotosApi by lazy { PhotosApi(httpClient, auth) }

    val photosModel: PhotosModel by lazy {
        PhotosModel(
            api = photosApi,
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

    val todayApi: TodayApi by lazy { TodayApi(httpClient, auth) }
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

    private var pantryCache: Pair<ZoneId, PantryModel>? = null

    /**
     * Pantry's expiry labels are formatted in the zone it was built with, and the household
     * zone arrives after first use — so the model is rebuilt when the zone changes.
     */
    @Synchronized
    fun pantryModel(zone: ZoneId): PantryModel =
        pantryCache?.takeIf { it.first == zone }?.second
            ?: PantryModel(
                api = PantryApi(httpClient, auth),
                baseUrl = serverAddress.baseUrl(),
                zone = zone,
                refreshBus = refreshBus,
                clock = ::householdToday,
            ).also { pantryCache = zone to it }

    // ---- Session scope -----------------------------------------------------------

    private val _sessionScope = MutableStateFlow(Any())

    /**
     * A fresh token per sign-in, household switch and server change. The Family models
     * drop every cached feed when it changes, so one account never sees another's rows.
     */
    val sessionScope: StateFlow<Any> = _sessionScope.asStateFlow()

    fun newSessionScope() {
        _sessionScope.value = Any()
    }

    // ---- Settings ----------------------------------------------------------------

    val settingsApi: SettingsApi by lazy { SettingsApi(httpClient, auth) }
    val householdSettingsApi: SettingsHouseholdApi by lazy { SettingsHouseholdApi(httpClient, auth) }

    /** Local event reminders, kept in step with the synced calendar for the process's life. */
    val eventReminders: EventReminders by lazy {
        EventReminders.create(appContext).also { it.bind(appScope, syncManager) }
    }

    val updateDismissal: UpdateDismissalStore = object : UpdateDismissalStore {
        override fun dismissedTag(): String? = prefs.getString(UPDATE_DISMISSED, null)
        override fun dismiss(tag: String) {
            prefs.edit().putString(UPDATE_DISMISSED, tag).apply()
        }
    }

    /**
     * About → Server. A new server must never inherit the old one's local mirror: the
     * address is swapped inside a clearing re-scope, which refuses while uploads are queued.
     */
    val serverConnection: ServerConnection = object : ServerConnection {
        override fun currentUrl(): String = serverAddress.baseUrl()
        override val defaultUrl: String = BuildConfig.DEFAULT_SERVER_URL
        override suspend fun change(input: String): ServerChange {
            val verdict = ServerUrl.validate(input)
            if (verdict !is ServerUrlVerdict.Ok) return ServerChange.Rejected(verdict)
            val pending = syncManager.pendingUploadCount()
            if (pending > 0) return ServerChange.PendingUploads(pending)
            if (!syncManager.rescope(clearLocal = true) { serverAddress.set(verdict.url) }) {
                return ServerChange.TeardownFailed
            }
            kioskMode.serverChanged()
            newSessionScope()
            return ServerChange.Updated(verdict.url)
        }
    }

    /**
     * Settings → Households: adopt the other household's tokens inside a clearing
     * re-scope, then re-read identity at once — the wipe resets the module gate, and the
     * tab bar would otherwise read "no modules" until the next refresh.
     */
    suspend fun adoptHouseholdSession(accessToken: String, refreshToken: String): Boolean {
        val ok = syncManager.rescope(clearLocal = true) { auth.adopt(TokenPair(accessToken, refreshToken)) }
        if (!ok) return false
        identity.clear()
        newSessionScope()
        identity.load()
        return true
    }

    // ---- Session phase -------------------------------------------------------------

    /**
     * `loading → login → shell`, owned here rather than by the gate's ViewModel: a kiosk
     * claim (outside the gate's composition) must flip it before `KioskMode` shows the shell.
     */
    val sessionPhase = MutableStateFlow<SessionPhase>(SessionPhase.Loading)

    /**
     * A full sign-out: drop reminders and identity, clear the tokens, flip to login, then
     * stop sync and revoke in the background. In [appScope], because the shell leaves
     * composition the moment the phase flips.
     */
    fun signOut() {
        eventReminders.clearEventReminders()
        identity.clear()
        newSessionScope()
        val refresh = auth.signOutAndReturnRefreshToken()
        sessionPhase.value = SessionPhase.SignedOut(null)
        appScope.launch {
            syncManager.stop()
            refresh?.let { runCatching { authApi.logout(it) } }
            if (sessionPhase.value is SessionPhase.SignedOut) {
                sessionPhase.value = SessionPhase.SignedOut(runCatching { authApi.status() }.getOrNull())
            }
        }
    }

    /** The kiosk boot cover's Retry: reconnect sync and re-read identity. */
    fun restartSync() {
        appScope.launch {
            syncManager.stop()
            syncManager.start()
            identity.load()
        }
    }

    // ---- Tablet kiosk --------------------------------------------------------------

    val kioskDeviceStore: KioskDeviceStore by lazy {
        KioskDeviceStore(keyValueStore, KeystoreTokenCrypto("waffled.kiosk.key"))
    }

    /** ONE device credential, shared by the API slice and the mode, so a re-pair invalidates both. */
    val kioskDeviceAuth: KioskDeviceAuth by lazy { KioskDeviceAuth(httpClient, kioskDeviceStore) }

    val kioskApi: KioskApi by lazy { KioskApi(httpClient, auth, kioskDeviceAuth) }

    /**
     * The picker changed the server without wiping the mirror (its setter is synchronous),
     * so the next claim's re-scope must clear it. Persisted: a restart in between must not
     * forget the old server's rows are still there.
     */
    private var kioskServerChanged: Boolean
        get() = prefs.getBoolean(KIOSK_NEEDS_CLEAR, false)
        set(value) = prefs.edit().putBoolean(KIOSK_NEEDS_CLEAR, value).apply()

    private val kioskSessionHost = object : KioskSessionHost {
        override fun isSignedIn(): Boolean = auth.isSignedIn()

        override suspend fun adopt(accessToken: String, refreshToken: String): Boolean {
            val clear = kioskServerChanged
            val ok = syncManager.rescope(clearLocal = clear) { auth.adopt(TokenPair(accessToken, refreshToken)) }
            if (!ok) return false
            if (clear) kioskServerChanged = false
            identity.clear()
            newSessionScope()
            sessionPhase.value = SessionPhase.SignedIn(emptyList())
            identity.load()
            return true
        }

        override suspend fun dropSession() {
            if (!auth.isSignedIn()) return
            eventReminders.clearEventReminders()
            auth.signOut()
            identity.clear()
            newSessionScope()
            syncManager.stop()
            sessionPhase.value = SessionPhase.SignedOut(null)
        }

        override suspend fun signOut() = this@AppContainer.signOut()
    }

    /** One instance for the gate, the shell and Settings → This device, so they agree. */
    val kioskMode: KioskMode by lazy { KioskMode(kioskDeviceStore, kioskApi, kioskDeviceAuth, kioskSessionHost) }

    /**
     * The picker's escape hatch. Synchronous by contract, so it cannot run the clearing
     * re-scope the About form does: it refuses while uploads are queued instead.
     */
    val kioskServerAddress: KioskServerAddress = object : KioskServerAddress {
        override fun current(): String = serverAddress.baseUrl()
        override fun set(input: String): String? {
            ServerAddressForm.shapeError(input)?.let { return it }
            val pending = syncManager.pendingUploads.value
            if (pending > 0) return ServerAddressForm.message(ServerChange.PendingUploads(pending)).error
            val verdict = serverAddress.set(input)
            if (verdict !is ServerUrlVerdict.Ok) return ServerAddressForm.message(ServerChange.Rejected(verdict)).error
            kioskServerChanged = true
            kioskMode.serverChanged()
            newSessionScope()
            return null
        }
    }

    val kioskRailStore: KioskRailStore by lazy { KioskRailStore(keyValueStore) }

    val screensaverModel: ScreensaverModel by lazy {
        ScreensaverModel.backedBy(householdSettingsApi, todayApi, photosApi)
    }

    val kioskCalendarApi: KioskCalendarApi by lazy { KioskCalendarApi(httpClient, auth) }
    val kioskTodayModel: KioskTodayModel by lazy { KioskTodayModel.from(todayApi, listsApi, goalsApi) }
    val kioskFamilyModel: KioskFamilyModel by lazy {
        KioskFamilyModel(fetchChores = familyApi::choresToday, fetchStars = familyApi::familyStars)
    }

    // ---- Weekly Planning -----------------------------------------------------------

    private var planningCache: Triple<Any, Boolean, PlanningEnvironment>? = null

    /**
     * Stable within a session (the shell remembers its model by env identity) and rebuilt
     * on a new session scope, since it captures the server's base URL.
     */
    @Synchronized
    fun planningEnv(isKiosk: Boolean): PlanningEnvironment {
        val scope = sessionScope.value
        planningCache?.let { (s, k, env) -> if (s === scope && k == isKiosk) return env }
        return PlanningEnvironment(
            client = httpClient,
            tokens = auth,
            sync = syncManager,
            refreshBus = refreshBus,
            baseUrl = serverAddress.baseUrl(),
            store = keyValueStore,
            isKiosk = isKiosk,
        ).also { planningCache = Triple(scope, isKiosk, it) }
    }

    // ---- Family ------------------------------------------------------------------

    val familyApi: FamilyApi by lazy { FamilyApi(httpClient, auth) }
    val familyHub: FamilyHubModel by lazy { FamilyHubModel.backedBy(familyApi) }

    /** ONE queue for the hub badges, the banner and the screen, so all three agree. */
    val approvals: ApprovalsModel by lazy { ApprovalsModel.backedBy(familyApi, refreshBus) }

    // ---- Capture, Waffled-Bites, Family Night, Rhythms ---------------------------

    val captureApi: CaptureApi by lazy { CaptureApi(httpClient, auth) }
    val bitesApi: WaffledBitesApi by lazy { WaffledBitesApi(httpClient, auth) }
    val familyNightApi: FamilyNightApi by lazy { FamilyNightApi(httpClient, auth) }
    val familyNightModel: FamilyNightModel by lazy { FamilyNightModel(familyNightApi) }

    val rhythmsModel: RhythmsModel by lazy {
        RhythmsModel.from(RhythmsApi(httpClient, auth), zone = { syncManager.householdZone.value })
    }

    private val _countdownsRev = MutableStateFlow(0)

    /** Bumped after a rhythm write: completion rhythms feed the countdown chips. */
    val countdownsRev: StateFlow<Int> = _countdownsRev.asStateFlow()

    fun bumpCountdowns() {
        _countdownsRev.value += 1
    }

    private companion object {
        const val UPDATE_DISMISSED = "waffled.update.dismissed"
        const val KIOSK_NEEDS_CLEAR = "waffled.kiosk.needsLocalClear"
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

    /** Kiosk Today layout preset (iOS `waffled.kioskDashLayout`); "" = default. */
    var kioskDashLayout: String
        get() = prefs.getString("waffled.kioskDashLayout", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.kioskDashLayout", value).apply()

    /** Kiosk Today's pinned goal (iOS `waffled.kioskGoalId`); "" = automatic. */
    var kioskGoalId: String
        get() = prefs.getString("waffled.kioskGoalId", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.kioskGoalId", value).apply()

    /** Today lists card: the pinned list id. */
    var todayListPick: String
        get() = prefs.getString("waffled.todayListPick", null).orEmpty()
        set(value) = prefs.edit().putString("waffled.todayListPick", value).apply()
}

/** Plain (unencrypted) per-device prefs behind the `core:auth` [KeyValueStore] seam. */
internal class SharedPrefsKeyValueStore(
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

