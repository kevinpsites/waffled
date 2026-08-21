package app.waffled.core.design

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A segmented control — the This-week / Recipes shell, the plan sheets, the cook-confirm
 * three-way.
 *
 * Three feature agents hand-rolled this independently before it lived here, so it is
 * shared now. It stays hand-drawn rather than wrapping M3's `SegmentedButton`: that
 * control is form-sized and draws a heavier container than these title-bar-scale rows
 * want.
 *
 * The selected segment fills with `ink` and uses `onInk` — never white, which would
 * vanish in dark where `ink` is warm off-white.
 */
@Composable
fun SegmentedRow(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val outer = RoundedCornerShape(WF.radius.pill)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.panel, outer)
            .clip(outer)
            .padding(3.dp),
    ) {
        options.forEachIndexed { index, label ->
            val selected = index == selectedIndex
            val inner = RoundedCornerShape(WF.radius.pill)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .then(
                        if (selected) Modifier.background(WF.colors.ink, inner) else Modifier,
                    )
                    .clip(inner)
                    .clickable { onSelect(index) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    style = TextStyle(
                        fontSize = 14.sp,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
                    ),
                    // `onInk`, not white — see the onInk rule.
                    color = if (selected) WF.colors.onInk else WF.colors.ink2,
                )
            }
        }
    }
}
