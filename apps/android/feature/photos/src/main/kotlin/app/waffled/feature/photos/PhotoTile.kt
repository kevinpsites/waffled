package app.waffled.feature.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
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
import app.waffled.core.design.colorFromHex
import app.waffled.core.design.wfShadow1
import coil3.compose.AsyncImage

/**
 * One tile on the wall — the port of iOS `PhotoTile`.
 *
 * A stored image clipped to a rounded rect, or an emoji-on-gradient fallback drawn from
 * the photo's `colorHex`. A ❤️ marks favourites and the caption sits over the bottom of
 * the tile on a scrim.
 */
@Composable
fun PhotoTile(
    row: PhotoRow,
    modifier: Modifier = Modifier,
    height: Dp = 150.dp,
    selecting: Boolean = false,
    selected: Boolean = false,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
            .wfShadow1(shape)
            .clip(shape)
            // Unpicked tiles dim while selecting, so the picked ones read as picked.
            .alpha(if (selecting && !selected) 0.78f else 1f),
    ) {
        if (row.resolvedImageUrl != null) {
            AsyncImage(
                model = WaffledImages.request(LocalContext.current, row.resolvedImageUrl, row.imageCacheKey),
                contentDescription = row.caption.ifEmpty { "Photo" },
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            EmojiTile(row = row, emojiSize = height.value * 0.32f)
        }

        if (row.isFavorite || row.caption.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    // The caption sits on a photo, so it uses the media pair — a scrim
                    // gradient under `onMedia`, never `onInk` (which vanishes in dark).
                    .background(
                        Brush.verticalGradient(listOf(Color.Transparent, WF.colors.scrim)),
                    )
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                if (row.caption.isNotEmpty()) {
                    Text(
                        text = row.caption,
                        modifier = Modifier.weight(1f),
                        style = TextStyle(fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold),
                        color = WF.colors.onMedia,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                }
                if (row.isFavorite) {
                    Text(text = "❤️", style = TextStyle(fontSize = 14.sp))
                }
            }
        }

        if (selecting) {
            SelectBadge(
                selected = selected,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(8.dp),
            )
        }

        if (selecting && selected) {
            Box(
                Modifier
                    .fillMaxSize()
                    .border(3.dp, WF.colors.primary, shape),
            )
        }
    }
}

/** The emoji-on-gradient fallback, tinted by the photo's own `colorHex`. */
@Composable
private fun EmojiTile(row: PhotoRow, emojiSize: Float) {
    // `colorHex` is real per-photo data, one of the two documented cases where a literal
    // colour is correct; `panel` is the fallback when it's missing or unparseable.
    val tint = colorFromHex(row.colorHex) ?: WF.colors.panel
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.linearGradient(listOf(tint, tint.copy(alpha = 0.7f))),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = row.emoji ?: "🏞️", style = TextStyle(fontSize = emojiSize.sp))
    }
}

/**
 * The multi-select check badge.
 *
 * Hand-rolled rather than a Material `Checkbox`: it sits **on a photo**, so it needs the
 * `onMedia` / `scrim` pair and a filled disc behind it to stay legible over any image —
 * none of which a themed Checkbox will do.
 */
@Composable
private fun SelectBadge(selected: Boolean, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(24.dp)
            .background(if (selected) WF.colors.onMedia else WF.colors.scrim, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = "Selected",
                tint = WF.colors.primary,
                modifier = Modifier.size(24.dp),
            )
        } else {
            Box(
                Modifier
                    .size(18.dp)
                    .border(2.dp, WF.colors.onMedia, CircleShape),
            )
        }
    }
}
