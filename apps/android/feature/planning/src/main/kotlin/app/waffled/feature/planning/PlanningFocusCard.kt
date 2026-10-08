package app.waffled.feature.planning

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard

/**
 * "This week's one thing" on a person's spotlight — a copy of web `PersonProfile.FocusCard`.
 * Takes plain values rather than the family feature's `PlanningFocus` so planning needn't
 * depend on family; the host (`app`) maps the one onto the other.
 */
@Composable
fun PlanningFocusCard(
    label: String,
    modifier: Modifier = Modifier,
    emoji: String = "",
    detail: String? = null,
) {
    WaffledCard(modifier.fillMaxWidth(), padding = 16.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "THIS WEEK’S ONE THING",
                style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp),
                color = WF.colors.ink3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (emoji.isNotEmpty()) Text(emoji, style = TextStyle(fontSize = 28.sp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(label, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = WF.colors.ink)
                    detail?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = TextStyle(fontSize = 13.sp), color = WF.colors.ink2)
                    }
                }
            }
            Text("said at this week’s planning session", style = TextStyle(fontSize = 12.sp), color = WF.colors.ink3)
        }
    }
}
