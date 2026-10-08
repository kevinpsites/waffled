package app.waffled.android.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.waffled.core.auth.AuthApi
import app.waffled.core.auth.AuthStatus
import app.waffled.core.auth.LoginResult
import app.waffled.core.auth.Membership
import app.waffled.core.auth.OidcCallback
import app.waffled.core.auth.TokenPair
import app.waffled.core.auth.WaffledAuth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The session state machine — `loading → login → authed`, matching the iOS `Session`.
 *
 * `loading` exists so the app doesn't flash the login screen at someone who is already
 * signed in while the stored token is read.
 */
sealed interface SessionPhase {
    data object Loading : SessionPhase
    data class SignedOut(val status: AuthStatus?) : SessionPhase
    data class SignedIn(val memberships: List<Membership>) : SessionPhase
}

data class LoginUiState(
    val email: String = "",
    val password: String = "",
    val isBusy: Boolean = false,
    val error: String? = null,
    /** The sign-in screen's "Server address" field. */
    val serverUrl: String = "",
) {
    val canSubmit: Boolean get() = !isBusy && email.isNotBlank() && password.isNotEmpty()
}

class SessionViewModel(
    private val auth: WaffledAuth,
    private val api: AuthApi,
    /** A new account context began or ended — the Family models re-scope on it. */
    private val onSessionChanged: () -> Unit = {},
    /** Owned by `AppContainer` so a kiosk claim can flip it from outside the gate. */
    private val _phase: MutableStateFlow<SessionPhase> = MutableStateFlow(SessionPhase.Loading),
    /** The person's refresh token died — a shared kiosk returns to its picker. */
    private val onExpired: () -> Unit = {},
    /** Install the signed-in pair; a non-null result is a refusal to show on the form. */
    private val adoptSession: suspend (TokenPair) -> String? = { auth.adopt(it); null },
    private val currentServer: () -> String = { "" },
    /** Switch servers from the sign-in screen; a non-null result is the refusal to show. */
    private val changeServer: suspend (String) -> String? = { null },
) : ViewModel() {

    val phase: StateFlow<SessionPhase> = _phase.asStateFlow()

    private val _login = MutableStateFlow(LoginUiState(serverUrl = currentServer()))
    val login: StateFlow<LoginUiState> = _login.asStateFlow()

    init {
        // A rejected refresh token, or a household that is gone, ends the session out from
        // under us. Re-read the login methods: a null status hides an OIDC-only stack's button.
        auth.onAuthExpired = {
            onSessionChanged()
            onExpired()
            _phase.value = SessionPhase.SignedOut(null)
            viewModelScope.launch { _phase.value = SessionPhase.SignedOut(api.status()) }
        }
        if (_phase.value == SessionPhase.Loading) restore()
    }

    private fun restore() {
        viewModelScope.launch {
            if (auth.isSignedIn()) {
                _phase.value = SessionPhase.SignedIn(emptyList())
                return@launch
            }
            // Ask the server which login methods it offers — self-hosted stacks differ.
            _phase.value = SessionPhase.SignedOut(api.status())
        }
    }

    fun onEmailChange(value: String) = _login.update { it.copy(email = value, error = null) }

    fun onPasswordChange(value: String) = _login.update { it.copy(password = value, error = null) }

    fun signIn() {
        val state = _login.value
        if (!state.canSubmit) return

        _login.update { it.copy(isBusy = true, error = null) }
        viewModelScope.launch { finishSignIn(api.login(state.email, state.password)) }
    }

    /** Where the SSO button sends the browser. */
    fun oidcStartUrl(): String = api.oidcStartUrl()

    /** The `waffled://auth/callback` deep link single sign-on returns through. */
    fun completeOidc(callbackUri: String) {
        when (val callback = OidcCallback.parse(callbackUri)) {
            OidcCallback.NotOurs -> return
            is OidcCallback.Failed -> _login.update { it.copy(isBusy = false, error = callback.message) }
            is OidcCallback.Code -> {
                _login.update { it.copy(isBusy = true, error = null) }
                viewModelScope.launch { finishSignIn(api.oidcExchange(callback.code)) }
            }
        }
    }

    private suspend fun finishSignIn(result: LoginResult) {
        when (result) {
            is LoginResult.Success -> {
                val refusal = adoptSession(result.tokens)
                if (refusal != null) {
                    _login.update { it.copy(isBusy = false, error = refusal) }
                    return
                }
                onSessionChanged()
                _login.value = LoginUiState(serverUrl = currentServer()) // don't keep the password around
                _phase.value = SessionPhase.SignedIn(result.memberships)
            }
            is LoginResult.Failed -> {
                _login.update { it.copy(isBusy = false, error = result.message) }
            }
        }
    }

    fun dismissError() = _login.update { it.copy(error = null) }

    fun onServerUrlChange(value: String) = _login.update { it.copy(serverUrl = value, error = null) }

    /** Switch to the typed server, then ask IT which sign-in methods it offers. */
    fun useServer() {
        val input = _login.value.serverUrl.trim()
        if (input.isEmpty() || _login.value.isBusy) return
        _login.update { it.copy(isBusy = true, error = null) }
        viewModelScope.launch {
            changeServer(input)?.let { refusal ->
                _login.update { it.copy(isBusy = false, error = refusal) }
                return@launch
            }
            val status = api.status()
            _login.update {
                it.copy(
                    isBusy = false,
                    serverUrl = currentServer(),
                    error = if (status == null) {
                        "Couldn't reach ${currentServer()}. Check the address and port, and that " +
                            "this phone is on the same network."
                    } else null,
                )
            }
            _phase.value = SessionPhase.SignedOut(status)
        }
    }
}
