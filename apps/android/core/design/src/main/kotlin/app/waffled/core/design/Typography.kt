package app.waffled.core.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * The type scale.
 *
 * iOS does **not** tokenise type — every call site inlines `.system(size: N)`. These
 * values are the measured de-facto sizes (by frequency across `apps/ios/Sources`),
 * declared properly here so Android doesn't inherit that inconsistency. Prefer a named
 * style; drop to [size] only for a genuine one-off.
 *
 * Frequencies behind the scale: 13 (309×), 14 (275), 12 (267), 15 (233), 16 (144),
 * 11 (141), 12.5 (117), 17 (52).
 */
object WaffledType {

    // Headings — the serif face, matching iOS `WF.serif(_:_:)`.
    val hero: TextStyle = serif(26.sp, FontWeight.Bold)
    val title: TextStyle = serif(22.sp, FontWeight.SemiBold)
    val sectionTitle: TextStyle = serif(18.sp, FontWeight.SemiBold)

    // Body / UI — the system sans.
    val cardTitle = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Bold)
    val fieldTitle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold)
    val body = TextStyle(fontSize = 15.sp)
    val bodySmall = TextStyle(fontSize = 13.sp)
    val label = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    val caption = TextStyle(fontSize = 12.sp)
    val micro = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold)

    /** Uppercase section label — heavy 12.5 with tracking; see [SectionLabel]. */
    val sectionLabel = TextStyle(
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Black,
        letterSpacing = 0.6.sp,
    )

    /**
     * The serif face used for headings.
     *
     * iOS uses New York (`.system(design: .serif)`), which Android does not have. This
     * resolves to the platform serif (Noto Serif on most devices) so headings read as
     * serif everywhere today.
     *
     * TODO: bundle Newsreader or Source Serif and pin the metrics for exact parity —
     * tracked in the port plan. Swapping the family here is the only change needed;
     * nothing else references a font directly.
     */
    fun serif(size: TextUnit, weight: FontWeight = FontWeight.SemiBold) = TextStyle(
        fontSize = size,
        fontWeight = weight,
        fontFamily = FontFamily.Serif,
    )

    /** Escape hatch for a one-off size that has no named style. */
    fun size(value: TextUnit, weight: FontWeight = FontWeight.Normal) =
        TextStyle(fontSize = value, fontWeight = weight)
}
