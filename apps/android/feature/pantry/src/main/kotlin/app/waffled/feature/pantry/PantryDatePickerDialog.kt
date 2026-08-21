package app.waffled.feature.pantry

import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The date picker for a best-by / added-on day.
 *
 * Material3's own dialog, not a hand-rolled calendar — but wrapped, because its API
 * speaks epoch millis in **UTC**. A naive `Instant.ofEpochMilli(…).atZone(systemDefault())`
 * shifts the chosen day by one anywhere west of Greenwich, which is exactly how a
 * date-only value drifts. Converting through [ZoneOffset.UTC] is what keeps "the 15th"
 * the 15th.
 *
 * (Calendar has the same wrapper. Neither feature module may depend on the other and
 * `core:design` is frozen, so it is duplicated rather than shared — reported as a
 * `core:design` candidate.)
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PantryDatePickerDialog(
    initial: LocalDate,
    onDismiss: () -> Unit,
    onPick: (LocalDate) -> Unit,
    /** Latest selectable day, or null for no ceiling. "Added / bought" can't be future. */
    maxDate: LocalDate? = null,
) {
    val ceiling = maxDate?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
    val state = rememberDatePickerState(
        initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                ceiling == null || utcTimeMillis <= ceiling

            // Year-level too, or the year picker still offers years with no selectable day.
            override fun isSelectableYear(year: Int): Boolean =
                maxDate == null || year <= maxDate.year
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    state.selectedDateMillis?.let {
                        onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate())
                    } ?: onDismiss()
                },
            ) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DatePicker(state = state)
    }
}
