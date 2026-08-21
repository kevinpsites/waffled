package app.waffled.feature.photos

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import app.waffled.core.design.WF
import app.waffled.core.design.wfField

/**
 * A boxed single-line text field.
 *
 * Hand-rolled on `BasicTextField` rather than Material3's `TextField`/`OutlinedTextField`
 * because those draw their own container, indicator line and floating label — chrome that
 * contradicts `wfField`, which is this repo's single source for field chrome (and what
 * iOS's `.wfField(fill:)` does). `BasicTextField` is the unstyled primitive that lets the
 * design system supply the look.
 */
@Composable
fun PhotoTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    fill: Color = WF.colors.panel,
    fontSize: androidx.compose.ui.unit.TextUnit = 16.sp,
    verticalPadding: Dp = 11.dp,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .wfField(fill = fill)
            .padding(horizontal = 13.dp, vertical = verticalPadding),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = TextStyle(fontSize = fontSize, color = WF.colors.ink),
            cursorBrush = SolidColor(WF.colors.primary),
            keyboardOptions = KeyboardOptions(capitalization = capitalization),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        style = TextStyle(fontSize = fontSize, fontWeight = FontWeight.Normal),
                        color = WF.colors.ink3,
                    )
                }
                inner()
            },
        )
    }
}
