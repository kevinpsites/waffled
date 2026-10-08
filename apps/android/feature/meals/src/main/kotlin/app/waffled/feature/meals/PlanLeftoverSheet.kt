package app.waffled.feature.meals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledFieldCard
import app.waffled.core.design.WaffledPrimaryCTA
import app.waffled.core.design.WeekdayToggleChip
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Plans a ready-to-eat pantry item onto a night as a free-text entry named for it — the
 * write behind Cook from your pantry's "Plan" (iOS `CookFromPantrySheet.planItem`). Meals
 * owns it; the pantry only hands over the name.
 */
class PlanLeftoverModel(
    private val api: MealsApi,
    val title: String,
    private val refreshBus: RefreshBus? = null,
) {
    private val _error = MutableStateFlow<String?>(null)

    /** The server's own words for a refused write; null after a success. */
    val error: StateFlow<String?> = _error.asStateFlow()

    suspend fun plan(date: LocalDate, mealType: String): Boolean {
        val done = runCatching { api.planMeal(date = MealsFormat.ymd(date), mealType = mealType, title = title.trim()) }
        done.exceptionOrNull()?.let { e ->
            _error.value = (e as? WaffledApiException)?.userMessage?.takeIf { it.isNotBlank() }
                ?: "Couldn't plan this. Check your connection and try again."
            return false
        }
        _error.value = null
        refreshBus?.bump(RefreshDomain.Meals)
        return true
    }

    companion object {
        val MEAL_TYPES: List<String> = listOf("breakfast", "lunch", "dinner", "snack")

        /** iOS offers any day from today on; a phone sheet offers the coming week. */
        fun dayChoices(today: LocalDate): List<LocalDate> = (0L until 7L).map { today.plusDays(it) }
    }
}

/**
 * The sheet for [PlanLeftoverModel]: a meal and a night, then Add. [today] is the
 * household's today. [onPlanned] gets the planned `yyyy-MM-dd` (the pantry marks the item
 * "✓ planned") and is followed by [onDismiss].
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PlanLeftoverSheet(
    title: String,
    today: LocalDate,
    api: MealsApi,
    onPlanned: (date: String) -> Unit,
    onDismiss: () -> Unit,
    refreshBus: RefreshBus? = null,
) {
    val model = remember(title, api) { PlanLeftoverModel(api, title, refreshBus) }
    val error by model.error.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var mealType by remember { mutableStateOf("dinner") }
    var day by remember(today) { mutableStateOf(today) }
    var saving by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        SheetHeader("Plan $title", onDismiss)
        Column(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            WaffledFieldCard(title = "Which meal?") {
                SegmentedRow(
                    options = PlanLeftoverModel.MEAL_TYPES,
                    selected = mealType,
                    label = MealsFormat::slotLabel,
                    onSelect = { mealType = it },
                )
            }
            WaffledFieldCard(title = "Which day?") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PlanLeftoverModel.dayChoices(today).forEach { d ->
                        WeekdayToggleChip(
                            label = if (d == today) "Today" else MealsFormat.weekdayShort(d).lowercase().replaceFirstChar { it.uppercase() },
                            isOn = d == day,
                            onClick = { day = d },
                        )
                    }
                }
            }
            error?.let { Text(it, style = WF.type.label, color = WF.colors.danger) }
            WaffledPrimaryCTA(
                label = if (saving) "Adding…" else "Add",
                onClick = {
                    if (saving) return@WaffledPrimaryCTA
                    saving = true
                    scope.launch {
                        val ok = model.plan(day, mealType)
                        saving = false
                        if (ok) {
                            onPlanned(MealsFormat.ymd(day))
                            onDismiss()
                        }
                    }
                },
            )
        }
    }
}
