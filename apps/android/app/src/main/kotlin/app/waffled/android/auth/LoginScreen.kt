package app.waffled.android.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.auth.AuthStatus
import app.waffled.core.design.DismissibleErrorBanner
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledPrimaryCTA

/**
 * The sign-in screen.
 *
 * Which controls appear is driven by what the SERVER says it supports
 * (`/api/auth/status`) — a self-hosted stack may offer password, OIDC, or both, so the
 * client must not assume.
 *
 * Uses `OutlinedTextField` rather than a hand-rolled input: reuse hierarchy says take the
 * native control first, and it brings focus handling, IME actions and accessibility for
 * free. Its colours are overridden to the WF tokens so it doesn't read as Material.
 */
@Composable
fun LoginScreen(
    state: LoginUiState,
    status: AuthStatus?,
    onEmailChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismissError: () -> Unit,
    onStartOidc: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Before status loads, assume password — it's what every stack has, and it avoids a
    // screen with no way in.
    val showPassword = status?.supportsPassword ?: true
    val showOidc = status?.supportsOidc ?: false

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("🧇", style = WF.type.size(56.sp))
            Text(
                text = "Waffled",
                style = WF.type.hero,
                color = WF.colors.ink,
            )
            Text(
                text = "Sign in to your household.",
                style = WF.type.bodySmall,
                color = WF.colors.ink3,
                textAlign = TextAlign.Center,
            )

            if (state.error != null) {
                DismissibleErrorBanner(message = state.error, onDismiss = onDismissError)
            }

            WaffledCard(padding = 16.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (showPassword) {
                        OutlinedTextField(
                            value = state.email,
                            onValueChange = onEmailChange,
                            label = { Text("Email") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Email,
                                imeAction = ImeAction.Next,
                            ),
                            colors = waffledFieldColors(),
                        )
                        OutlinedTextField(
                            value = state.password,
                            onValueChange = onPasswordChange,
                            label = { Text("Password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Password,
                                imeAction = ImeAction.Go,
                            ),
                            keyboardActions = KeyboardActions(onGo = { onSubmit() }),
                            colors = waffledFieldColors(),
                        )
                        WaffledPrimaryCTA(
                            label = "Sign in",
                            onClick = onSubmit,
                            isBusy = state.isBusy,
                            isDisabled = !state.canSubmit && !state.isBusy,
                        )
                    }

                    if (showOidc) {
                        WaffledPrimaryCTA(
                            label = status?.oidcButtonLabel ?: "Continue with single sign-on",
                            onClick = onStartOidc,
                            tint = WF.colors.ai,
                            isDisabled = state.isBusy,
                        )
                    }

                    if (!showPassword && !showOidc) {
                        Text(
                            text = "This server hasn't finished setting up sign-in yet.",
                            style = WF.type.bodySmall,
                            color = WF.colors.ink3,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun waffledFieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = WF.colors.card,
    unfocusedContainerColor = WF.colors.card,
    focusedIndicatorColor = WF.colors.primary,
    unfocusedIndicatorColor = WF.colors.hair,
    focusedTextColor = WF.colors.ink,
    unfocusedTextColor = WF.colors.ink,
    focusedLabelColor = WF.colors.ink2,
    unfocusedLabelColor = WF.colors.ink3,
    cursorColor = WF.colors.primary,
)

