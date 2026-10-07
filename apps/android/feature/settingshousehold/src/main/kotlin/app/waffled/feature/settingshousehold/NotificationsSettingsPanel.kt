package app.waffled.feature.settingshousehold

import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.waffled.core.design.WF

/**
 * Settings → Notifications: on-device event reminders. Everything here is local — no
 * server, no push. Turning reminders on asks for the notification permission first.
 */
@Composable
fun NotificationsSettingsPanel(reminders: EventReminders, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val prefs by reminders.prefs.collectAsState()
    var allowed by remember { mutableStateOf(notificationsAllowed(context)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        allowed = notificationsAllowed(context)
        reminders.refresh()
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        allowed = notificationsAllowed(context)
        reminders.refresh()
    }

    val leads = listOf(0 to "At start", 5 to "5 min", 15 to "15 min", 30 to "30 min", 60 to "1 hour")
    val hours = listOf(6, 7, 8, 9, 10, 12, 18)

    SettingsPage(modifier, spacing = 22.dp, horizontal = 20.dp) {
        Text(
            buildAnnotatedString {
                append("Reminders are scheduled ")
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("on this device") }
                append(" from your synced calendar, so they work offline. They don't send anything to a server.")
            },
            style = TextStyle(fontSize = 13.sp),
            color = WF.colors.ink2,
        )

        FlatCard {
            ToggleRow("Event reminders", "Get a heads-up before your calendar events", prefs.enabled) { on ->
                reminders.setEnabled(on)
                if (on && !allowed && Build.VERSION.SDK_INT >= 33) {
                    ask.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        }

        if (prefs.enabled && !allowed) {
            FlatCard {
                Column(Modifier.padding(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    RowLabel("Notifications are turned off", "Allow Waffled to send notifications in Android Settings to get reminders.")
                    Text(
                        "Open Settings",
                        Modifier.clickable {
                            context.startActivity(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        },
                        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.primary,
                    )
                }
            }
        }

        if (prefs.enabled) {
            FlatCard {
                SettingsMenuRow(
                    "Remind me",
                    leads.firstOrNull { it.first == prefs.leadMinutes }?.second ?: "15 min",
                    leads.map { (m, label) -> label to { reminders.setLeadMinutes(m) } },
                )
                HairDivider()
                SettingsMenuRow(
                    "All-day events at",
                    EventReminderPlanner.hourLabel(prefs.allDayHour),
                    hours.map { h -> EventReminderPlanner.hourLabel(h) to { reminders.setAllDayHour(h) } },
                )
                HairDivider()
                SettingsMenuRow(
                    "Which events",
                    if (prefs.myEventsOnly) "My events only" else "Everyone’s",
                    listOf("My events only" to { reminders.setMyEventsOnly(true) }, "Everyone’s" to { reminders.setMyEventsOnly(false) }),
                )
            }
            Caption("Reminders cover your upcoming events. Recurring events and chore reminders are coming separately.")
        }
    }
}

@Composable
private fun FlatCard(content: @Composable ColumnScope.() -> Unit) =
    HairlineCard(padding = 0.dp) { Column(Modifier.padding(horizontal = 18.dp), content = content) }
