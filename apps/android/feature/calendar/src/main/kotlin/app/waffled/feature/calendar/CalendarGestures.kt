package app.waffled.feature.calendar

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import kotlin.math.abs

/**
 * A sideways flick that steps the calendar (month, day) by ±1.
 *
 * Once the drag is clearly horizontal it consumes the moves, so a tappable cell or hour row
 * it lifts on does not also fire — a swipe between days must not open "New event". Vertical
 * drags are left alone for the scroller underneath. With [guardBackEdge] a drag that starts
 * in the system back-gesture strip never pages.
 */
@Composable
internal fun Modifier.calendarFlick(guardBackEdge: Boolean = false, onStep: (Int) -> Unit): Modifier {
    val step by rememberUpdatedState(onStep)
    return pointerInput(guardBackEdge) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            var total = Offset.Zero
            var horizontal = false
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (event.changes.count { it.pressed } > 1) return@awaitEachGesture
                if (!change.pressed) break
                total += change.positionChange()
                if (!horizontal && abs(total.x) > viewConfiguration.touchSlop && abs(total.x) > abs(total.y)) {
                    horizontal = true
                }
                if (horizontal) change.consume()
            }
            if (!horizontal) return@awaitEachGesture
            // Thresholds are in dp, like iOS points; pointer positions are pixels.
            val dx = total.x / density
            val dy = total.y / density
            val startX = down.position.x / density
            val s = if (guardBackEdge) PhoneCalendar.daySwipeStep(startX, dx, dy) else HorizontalSwipe.step(dx, dy)
            s?.let(step)
        }
    }
}

/**
 * Spread to zoom the calendar in (Month → Week → Day), pinch to zoom back out.
 *
 * Reacts only while two fingers are down and never consumes a one-finger event, so it can
 * sit over the paging and scrolling below it.
 */
@Composable
internal fun Modifier.calendarPinchZoom(onZoom: (zoomIn: Boolean) -> Unit): Modifier {
    val zoom by rememberUpdatedState(onZoom)
    return pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            var scale = 1f
            var pinched = false
            while (true) {
                val event = awaitPointerEvent()
                val pressed = event.changes.count { it.pressed }
                if (pressed == 0) break
                if (pressed >= 2) {
                    pinched = true
                    scale *= event.calculateZoom()
                }
            }
            if (!pinched) return@awaitEachGesture
            if (scale > 1.25f) zoom(true) else if (scale < 0.8f) zoom(false)
        }
    }
}
