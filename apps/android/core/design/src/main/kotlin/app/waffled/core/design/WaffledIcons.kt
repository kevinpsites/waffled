package app.waffled.core.design

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Glyphs that have no Material equivalent, hand-rolled so we don't depend on the
 * deprecated `material-icons-extended` artifact.
 *
 * The port maps SF Symbols → Material Symbols wherever a match exists (use
 * `androidx.compose.material.icons.Icons.Filled.*`); this file is only for the ones
 * that don't map. Add to it rather than reaching for another icon dependency.
 */
object WaffledIcons {

    /** SF `sparkles` — the AI marker on the capture bar and every AI action. */
    val Sparkles: ImageVector by lazy {
        ImageVector.Builder(
            name = "Sparkles",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            // Large four-point star, centred slightly up-left.
            path(fill = SolidColor(Color.White)) {
                moveTo(10f, 2f)
                lineTo(11.7f, 7.3f)
                lineTo(17f, 9f)
                lineTo(11.7f, 10.7f)
                lineTo(10f, 16f)
                lineTo(8.3f, 10.7f)
                lineTo(3f, 9f)
                lineTo(8.3f, 7.3f)
                close()
            }
            // Small companion star, lower-right.
            path(fill = SolidColor(Color.White)) {
                moveTo(18f, 14f)
                lineTo(18.9f, 16.6f)
                lineTo(21.5f, 17.5f)
                lineTo(18.9f, 18.4f)
                lineTo(18f, 21f)
                lineTo(17.1f, 18.4f)
                lineTo(14.5f, 17.5f)
                lineTo(17.1f, 16.6f)
                close()
            }
        }.build()
    }

    /** SF `mic.fill` — dictation, on the capture bar. */
    val Mic: ImageVector by lazy {
        ImageVector.Builder(
            name = "Mic",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            // Capsule head.
            path(fill = SolidColor(Color.White)) {
                moveTo(12f, 2f)
                curveTo(10.6f, 2f, 9.5f, 3.1f, 9.5f, 4.5f)
                lineTo(9.5f, 11.5f)
                curveTo(9.5f, 12.9f, 10.6f, 14f, 12f, 14f)
                curveTo(13.4f, 14f, 14.5f, 12.9f, 14.5f, 11.5f)
                lineTo(14.5f, 4.5f)
                curveTo(14.5f, 3.1f, 13.4f, 2f, 12f, 2f)
                close()
            }
            // Cradle arc + stand.
            path(fill = SolidColor(Color.White)) {
                moveTo(17.5f, 11.5f)
                curveTo(17.5f, 14.5f, 15.1f, 17f, 12f, 17f)
                curveTo(8.9f, 17f, 6.5f, 14.5f, 6.5f, 11.5f)
                lineTo(5f, 11.5f)
                curveTo(5f, 15.1f, 7.7f, 18.1f, 11.2f, 18.5f)
                lineTo(11.2f, 21f)
                lineTo(12.8f, 21f)
                lineTo(12.8f, 18.5f)
                curveTo(16.3f, 18.1f, 19f, 15.1f, 19f, 11.5f)
                close()
            }
        }.build()
    }
}
