package app.waffled.android

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import app.waffled.android.shell.FlexSlot
import app.waffled.android.shell.TabSlot
import app.waffled.android.shell.WaffledTabBar
import app.waffled.core.design.AICaptureBar
import app.waffled.core.design.Avatar
import app.waffled.core.design.FamilyColor
import app.waffled.core.design.Pill
import app.waffled.core.design.SectionLabel
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledCard
import app.waffled.core.design.WaffledEmojiTile
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WaffledStatusBadge
import app.waffled.core.design.WaffledTheme
import app.waffled.core.sync.ModuleGate

class WaffledApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as WaffledApp).container

        setContent {
            val forcedDark = container.themeStore.pref.forcedDark
            WaffledTheme(
                darkTheme = forcedDark
                    ?: androidx.compose.foundation.isSystemInDarkTheme(),
            ) {
                AppRoot()
            }
        }
    }
}

/**
 * The phone shell.
 *
 * Phase 0 renders the real chrome — the flex-slot tab bar and the design system — with
 * feature content still to come. Each Wave A agent replaces one tab's body.
 */
@Composable
private fun AppRoot() {
    // Before the household's module flags arrive, catalog defaults apply so the bar
    // doesn't flash empty.
    val gate = remember { ModuleGate(loaded = false) }
    val tabs = remember(gate) { FlexSlot.tabs(gate) }
    var selected by remember { mutableStateOf(tabs.first()) }

    Box(
        Modifier
            .fillMaxSize()
            .background(WF.colors.canvas),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .verticalScroll(rememberScrollState())
                // Content scrolls UNDER the bar, so every screen owes this clearance.
                .padding(
                    start = 16.dp,
                    end = 16.dp,
                    top = 12.dp,
                    bottom = WF.spacing.tabBarClearance,
                ),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = "Good afternoon",
                style = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold),
                color = WF.colors.ink,
            )

            AICaptureBar()

            SectionLabel("Design system")

            WaffledCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Phase 0 foundation",
                        style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    Text(
                        text = "Tokens, components and the tab bar are live. " +
                            "Feature screens land in Wave A.",
                        style = TextStyle(fontSize = 13.sp),
                        color = WF.colors.ink2,
                    )
                }
            }

            WaffledCard {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "Family",
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
                        color = WF.colors.ink,
                    )
                    androidx.compose.foundation.layout.Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(FamilyColor.Person1, "🐷")
                        Avatar(FamilyColor.Person2, "🦊")
                        Avatar(FamilyColor.Person3, "🐸")
                        Avatar(FamilyColor.Person4, "🦉")
                    }
                    androidx.compose.foundation.layout.Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Pill("Spendable")
                        WaffledStatusBadge("3 pending", WF.colors.warn)
                        WaffledEmojiTile("🥕")
                    }
                    WaffledPrimaryCTA(label = "Primary action", onClick = {})
                    WaffledPrimaryCTA(
                        label = "AI action",
                        onClick = {},
                        tint = WF.colors.ai,
                    )
                }
            }

            WaffledEmptyState(
                emoji = "🧇",
                title = "Nothing here yet",
                message = "Wave A fills these tabs in.",
            )
        }

        WaffledTabBar(
            tabs = tabs,
            selected = selected,
            onSelect = { selected = it },
            onCapture = {},
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}
