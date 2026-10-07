package app.waffled.android

import android.app.Application
import android.content.Intent
import android.content.pm.ActivityInfo
import app.waffled.feature.kiosk.KioskGate
import app.waffled.feature.kiosk.KioskShellLayout
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import app.waffled.android.auth.AuthGate
import app.waffled.android.shell.AppRoute
import app.waffled.android.shell.AppShell
import app.waffled.android.shell.LaunchRequest
import app.waffled.android.shell.TAB_TODAY
import app.waffled.core.design.WaffledTheme
import app.waffled.feature.recipes.cookTimerLinkFrom
import app.waffled.feature.settingshousehold.EventReminderReceiver
import kotlinx.coroutines.launch

class WaffledApp : Application(), coil3.SingletonImageLoader.Factory {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }

    /**
     * Install the shared image loader. Configured in `core:design` (see [WaffledImages])
     * because every image-bearing feature depends on it and no feature module owns `app`.
     * Features just call `AsyncImage` and get the memory cache for free.
     */
    override fun newImageLoader(context: coil3.PlatformContext): coil3.ImageLoader =
        app.waffled.core.design.WaffledImages.loader(this)
}

class MainActivity : ComponentActivity() {

    /** What the latest intent asked for, consumed once by the shell. */
    private var launchRequest by mutableStateOf<LaunchRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as WaffledApp).container
        // Phones stay portrait; a tablet (the kiosk shell) rotates freely. Decided here, not
        // in the manifest, because the manifest can't tell the two apart.
        val tablet = KioskShellLayout.isTablet(resources.configuration.smallestScreenWidthDp)
        requestedOrientation =
            if (tablet) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        // A recreation (theme flip) keeps the nav stack; replaying the launch intent would
        // re-push its route on top of wherever the user has since gone.
        if (savedInstanceState == null) handle(intent)

        setContent {
            val themePref by container.themeStore.prefFlow.collectAsStateWithLifecycle()
            val forcedDark = themePref.forcedDark
            WaffledTheme(
                darkTheme = forcedDark
                    ?: androidx.compose.foundation.isSystemInDarkTheme(),
            ) {
                // A paired shared kiosk shows its profile picker instead of the login screen.
                KioskGate(container.kioskMode, container.kioskServerAddress) {
                    AuthGate(container) {
                        AppShell(
                            container = container,
                            launch = launchRequest,
                            onLaunchHandled = { launchRequest = null },
                            isTablet = tablet,
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        // A tapped cook-timer notification: resume that dish + step, then raise Cook Mode.
        cookTimerLinkFrom(intent)?.let { link ->
            val store = (application as WaffledApp).container.cookStore
            lifecycleScope.launch {
                store.openFromNotification(link)
                launchRequest = LaunchRequest.Cook
            }
            return
        }
        // A tapped event reminder.
        intent?.getStringExtra(EventReminderReceiver.EXTRA_EVENT_ID)?.takeIf { it.isNotEmpty() }?.let { id ->
            intent.removeExtra(EventReminderReceiver.EXTRA_EVENT_ID)
            launchRequest = LaunchRequest.Event(id)
            return
        }
        // Debug-only headless verification: `--es waffled.route goals [--es waffled.tab family]`,
        // and `--es waffled.server http://10.0.2.2:8081` to point at another local stack.
        if (BuildConfig.DEBUG) {
            intent?.getStringExtra(EXTRA_SERVER)?.let { (application as WaffledApp).container.serverAddress.set(it) }
            AppRoute.fromDebugKey(intent?.getStringExtra(EXTRA_ROUTE))?.let { route ->
                launchRequest = LaunchRequest.Route(
                    tab = intent?.getStringExtra(EXTRA_TAB) ?: TAB_TODAY,
                    route = route,
                )
            }
        }
    }

    private companion object {
        const val EXTRA_ROUTE = "waffled.route"
        const val EXTRA_TAB = "waffled.tab"
        const val EXTRA_SERVER = "waffled.server"
    }
}
