package app.waffled.feature.recipes

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledImages
import coil3.compose.AsyncImage

/**
 * The recipe-shaped building blocks the library, the detail and the builder all share.
 *
 * Reuse order, per the repo rule: a native Material3 control first, then `core:design` +
 * `WF.*` tokens, and hand-rolled only with a reason. What is hand-rolled here and why:
 *
 *  - [RecipeHero] — an image-or-gradient tile with text over it. `core:design` has no
 *    media surface (its cards are theme surfaces, and text on them uses `ink`); this one
 *    carries the `scrim` + `onMedia` pair that photos require.
 *  - [TagChip] — `wfChip` is the *selectable* chip (picker state). These are read-only
 *    metadata pills in six semantic colours, which `wfChip`'s selected/unselected shape
 *    cannot express.
 */

/**
 * The hero at the top of a recipe card or detail: the real photo when there is one, else
 * the category gradient with the recipe's emoji.
 *
 * **Always [AsyncImage] with [WaffledImages.request], never a bare URL.** These live in a
 * lazy grid, and a naive loader re-fetches and re-decodes on every cell recreation — on
 * iOS that produced multi-second lag on every search keystroke. The cache key is the
 * storage path, never the (possibly signed) URL: a signed URL is an expiry, not an
 * identity, so keying on it means the cache never hits.
 */
@Composable
fun RecipeHero(
    imageUrl: String?,
    cacheKey: String?,
    emoji: String?,
    category: String?,
    modifier: Modifier = Modifier,
    height: Dp = 104.dp,
    emojiSize: Int = 42,
    content: @Composable BoxScope.() -> Unit = {},
) {
    Box(modifier.fillMaxWidth().height(height)) {
        if (imageUrl != null) {
            AsyncImage(
                model = WaffledImages.request(LocalContext.current, imageUrl, cacheKey),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            val (from, to) = remember(category) { RecipeGradient.stops(category) }
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        // An identity palette, not a theme surface — one of the two
                        // documented cases where a literal colour is correct.
                        Brush.linearGradient(
                            listOf(Color(0xFF000000L or from), Color(0xFF000000L or to)),
                        ),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = emoji ?: RecipeGradient.emoji(category),
                    style = TextStyle(fontSize = emojiSize.sp),
                )
            }
        }
        content()
    }
}

/**
 * A metadata pill on the recipe detail — plain, or tinted for dietary / veg / collection /
 * tag / new.
 */
enum class TagStyle { Plain, Collection, Dietary, Veg, Soft, New }

@Composable
fun TagChip(
    text: String,
    modifier: Modifier = Modifier,
    style: TagStyle = TagStyle.Plain,
    onRemove: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(WF.radius.pill)
    val fg = when (style) {
        TagStyle.Plain -> WF.colors.ink2
        TagStyle.Collection -> WF.colors.info
        TagStyle.Dietary -> WF.colors.ai
        TagStyle.Veg -> WF.colors.success
        TagStyle.Soft -> WF.colors.ink3
        TagStyle.New -> WF.colors.primary
    }
    val bg = when (style) {
        TagStyle.Plain -> WF.colors.panel
        TagStyle.Soft -> Color.Transparent
        else -> fg.copy(alpha = 0.12f)
    }
    Row(
        modifier = modifier
            .background(bg, shape)
            .then(if (style == TagStyle.Soft) Modifier.border(1.dp, WF.colors.hair, shape) else Modifier)
            .padding(horizontal = 11.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = text, style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold), color = fg)
        if (onRemove != null) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = "Remove $text",
                tint = WF.colors.ink3,
                modifier = Modifier.size(12.dp).clickable(onClick = onRemove),
            )
        }
    }
}

/** One "🌍 mexican" fragment of a card's meta line. */
@Composable
fun MetaBit(icon: String, text: String, modifier: Modifier = Modifier) {
    Text(
        text = "$icon $text",
        modifier = modifier,
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium),
        color = WF.colors.ink2,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}
