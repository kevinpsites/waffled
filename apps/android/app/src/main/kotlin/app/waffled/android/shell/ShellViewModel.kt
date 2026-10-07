package app.waffled.android.shell

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

/**
 * Holds the shell's navigation across configuration changes (a theme flip or a locale
 * change recreates the Activity). A ViewModel rather than `rememberSaveable`: routes carry
 * feature DTOs that aren't all `@Serializable`, and a Bundle would cap the stack's size.
 * A process death still lands on Today, as iOS does.
 */
class ShellViewModel : ViewModel() {
    var nav by mutableStateOf(NavState<AppRoute>(tab = TAB_TODAY))

    /** An event the Calendar tab opens on arrival; cleared once its detail is showing. */
    var pendingEventId by mutableStateOf<String?>(null)

    /** The tablet's per-rail-page drill-in stacks. */
    var kioskStacks by mutableStateOf(KioskPageStacks<AppRoute>())
}
