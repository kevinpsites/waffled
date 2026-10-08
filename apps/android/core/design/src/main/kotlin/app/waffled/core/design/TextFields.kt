package app.waffled.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The boxed text input.
 *
 * Built on `BasicTextField` rather than Material3's `TextField`/`OutlinedTextField`
 * deliberately: those draw their own container, indicator and floating label from the M3
 * colour scheme, which this app does not populate — so they fight [wfField], the single
 * source of boxed-field chrome. Two feature agents independently hand-rolled this before
 * it lived here; it is shared now so a third doesn't.
 *
 * The label sits above the box (not floating), matching the iOS forms.
 */
@Composable
fun WaffledTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minHeight: Dp = 44.dp,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    Column(modifier) {
        if (label != null) {
            Text(
                text = label,
                style = WF.type.micro,
                color = WF.colors.ink2,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = minHeight)
                .wfField()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            contentAlignment = androidx.compose.ui.Alignment.CenterStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                textStyle = LocalTextStyle.current.merge(
                    TextStyle(fontSize = WF.type.body.fontSize, color = WF.colors.ink),
                ),
                cursorBrush = SolidColor(WF.colors.primary),
                keyboardOptions = keyboardOptions,
                keyboardActions = keyboardActions,
                visualTransformation = visualTransformation,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
                decorationBox = { inner ->
                    if (value.isEmpty() && placeholder != null) {
                        Text(placeholder, style = WF.type.body, color = WF.colors.ink3)
                    }
                    inner()
                },
            )
        }
    }
}

/**
 * The quieter counterpart to [WaffledPrimaryCTA] — same metrics, panel fill, ink text.
 *
 * For the second button in a pair (Cancel next to Save), or an action that shouldn't
 * compete with the primary one. Use `ApprovalActionPair` for deny/approve specifically.
 */
@Composable
fun WaffledSecondaryCTA(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    isDisabled: Boolean = false,
) {
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(WF.radius.md)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.panel, shape)
            .clip(shape)
            .clickable(enabled = !isDisabled, onClick = onClick)
            .padding(vertical = 14.dp),
        contentAlignment = androidx.compose.ui.Alignment.Center,
    ) {
        Text(
            text = label,
            style = androidx.compose.ui.text.TextStyle(
                fontSize = 16.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            ),
            // `ink2`, not white — this is a panel fill, not a saturated one.
            color = if (isDisabled) WF.colors.ink3 else WF.colors.ink2,
        )
    }
}
