package app.waffled.android.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledIcons
import app.waffled.core.design.wfShadow3

/**
 * The phone tab bar — hand-drawn rather than a Material `NavigationBar`.
 *
 * This is the documented exception to "use a native control first": the raised centre
 * FAB has to break the bar's plane, which `NavigationBar` cannot do. Five slots, with
 * the FAB in the middle so it stays centred no matter which module fills the flex slot.
 *
 * Content scrolls UNDER this bar (it is drawn over the content, not inset), which is
 * what `WF.spacing.tabBarClearance` is for — every screen must apply it as bottom
 * padding.
 */
@Composable
fun WaffledTabBar(
    tabs: List<TabSlot>,
    selected: TabSlot,
    onSelect: (TabSlot) -> Unit,
    onCapture: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(WF.colors.card)
                .navigationBarsPadding()
                .height(64.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            // Slots 1-2, then the FAB's gap, then 4-5.
            tabs.take(2).forEach { TabButton(it, it == selected) { onSelect(it) } }

            Box(Modifier.size(56.dp)) // the FAB's reserved gap

            tabs.drop(2).forEach { TabButton(it, it == selected) { onSelect(it) } }
        }

        // The raised capture FAB, breaking the bar's plane.
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .offset(y = (-18).dp)
                .size(56.dp)
                .wfShadow3(CircleShape)
                .background(WF.colors.ai, CircleShape)
                .clickable(onClick = onCapture),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = WaffledIcons.Sparkles,
                contentDescription = "Add anything",
                tint = Color.White,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

@Composable
private fun TabButton(slot: TabSlot, isSelected: Boolean, onClick: () -> Unit) {
    val tint = if (isSelected) WF.colors.primary else WF.colors.ink3
    Column(
        modifier = Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Icon(
            imageVector = slot.icon,
            contentDescription = slot.label,
            tint = tint,
            modifier = Modifier.size(22.dp),
        )
        Text(
            text = slot.label,
            style = TextStyle(
                fontSize = 10.sp,
                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
            ),
            color = tint,
        )
    }
}

/** One slot in the bar. */
data class TabSlot(
    val id: String,
    val label: String,
    val icon: ImageVector,
)
