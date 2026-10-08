package app.waffled.android.auth

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledLoading

/**
 * Stands between the user and the app: `loading → login → shell`.
 *
 * The loading phase matters — it stops the login screen flashing at someone who is
 * already signed in while the encrypted token is read back.
 */
@Composable
fun AuthGate(
    container: AppContainer,
    content: @Composable (SessionViewModel) -> Unit,
) {
    val vm: SessionViewModel = viewModel(
        factory = remember(container) { sessionViewModelFactory(container) },
    )
    val phase by vm.phase.collectAsStateWithLifecycle()
    val login by vm.login.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val oidcCallback by container.pendingOidcCallback.collectAsStateWithLifecycle()
    LaunchedEffect(oidcCallback) {
        val uri = oidcCallback ?: return@LaunchedEffect
        container.pendingOidcCallback.value = null
        vm.completeOidc(uri)
    }

    when (val p = phase) {
        SessionPhase.Loading -> Box(
            Modifier
                .fillMaxSize()
                .background(WF.colors.canvas),
            contentAlignment = Alignment.Center,
        ) {
            WaffledLoading(top = 0.dp)
        }

        is SessionPhase.SignedOut -> LoginScreen(
            state = login,
            status = p.status,
            onEmailChange = vm::onEmailChange,
            onPasswordChange = vm::onPasswordChange,
            onSubmit = vm::signIn,
            onDismissError = vm::dismissError,
            onServerUrlChange = vm::onServerUrlChange,
            onUseServer = vm::useServer,
            // The provider's page opens in a Custom Tab and returns through the
            // `waffled://auth/callback` deep link (MainActivity → pendingOidcCallback).
            onStartOidc = {
                CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(vm.oidcStartUrl()))
            },
        )

        is SessionPhase.SignedIn -> content(vm)
    }
}

@Suppress("UNCHECKED_CAST")
private fun sessionViewModelFactory(container: AppContainer) =
    object : ViewModelProvider.Factory {
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            SessionViewModel(
                auth = container.auth,
                api = container.authApi,
                onSessionChanged = container::newSessionScope,
                _phase = container.sessionPhase,
                onExpired = { container.kioskMode.onPersonSessionExpired() },
                adoptSession = container::adoptSignIn,
                currentServer = container.serverConnection::currentUrl,
                changeServer = container::changeServerFromLogin,
            ) as T
    }
