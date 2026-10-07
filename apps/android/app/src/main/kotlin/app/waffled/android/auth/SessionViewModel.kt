package app.waffled.android.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.waffled.core.auth.AuthApi
import app.waffled.core.auth.AuthStatus
import app.waffled.core.auth.LoginResult
import app.waffled.core.auth.Membership
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
) {
    val canSubmit: Boolean get() = !isBusy && email.isNotBlank() && password.isNotEmpty()
}

class SessionViewModel(
    private val auth: WaffledAuth,
    private val api: AuthApi,
) : ViewModel() {

    private val _phase = MutableStateFlow<SessionPhase>(SessionPhase.Loading)
    val phase: StateFlow<SessionPhase> = _phase.asStateFlow()

    private val _login = MutableStateFlow(LoginUiState())
    val login: StateFlow<LoginUiState> = _login.asStateFlow()

    init {
        // A rejected refresh token, or a household that is gone, ends the session out from
        // under us. Re-read the login methods: a null status hides an OIDC-only stack's button.
        auth.onAuthExpired = {
            _phase.value = SessionPhase.SignedOut(null)
            viewModelScope.launch { _phase.value = SessionPhase.SignedOut(api.status()) }
        }
        restore()
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
        viewModelScope.launch {
            when (val result = api.login(state.email, state.password)) {
                is LoginResult.Success -> {
                    auth.adopt(result.tokens)
                    _login.value = LoginUiState() // don't keep the password around
                    _phase.value = SessionPhase.SignedIn(result.memberships)
                }
                is LoginResult.Failed -> {
                    _login.update { it.copy(isBusy = false, error = result.message) }
                }
            }
        }
    }

    fun signOut() {
        // Optimistic, like iOS: clear locally and flip immediately, revoke in the
        // background. A failed revoke must not trap the user in a session they left.
        val refresh = auth.let { it.signOutAndReturnRefreshToken() }
        _phase.value = SessionPhase.SignedOut(null)
        viewModelScope.launch {
            refresh?.let { api.logout(it) }
            _phase.value = SessionPhase.SignedOut(api.status())
        }
    }

    fun dismissError() = _login.update { it.copy(error = null) }
}
