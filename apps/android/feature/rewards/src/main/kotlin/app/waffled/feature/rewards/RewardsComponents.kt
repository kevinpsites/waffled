package app.waffled.feature.rewards

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.GpsFixed
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.WF
import app.waffled.core.design.colorFromHex

/**
 * The pieces shared across the Rewards tab, the shop and the sheets.
 *
 * All four presentations of the ONE earning ledger live here: the coin chip (a raw
 * balance), the jar and the progress bar (the same balance against a target), and the
 * saving-toward hero that frames them. None of these is a separate currency.
 */

/** The currency tint, falling back to gold when the household hasn't picked one. */
@Composable
internal fun currencyTint(colorHex: String?): Color = colorFromHex(colorHex) ?: WF.colors.gold

/**
 * A currency amount rendered like the web `Coin` — the symbol plus the number, tinted
 * with the currency's own colour on a wash of the same hue.
 */
@Composable
fun CoinChip(
    symbol: String,
    colorHex: String?,
    amount: Int,
    modifier: Modifier = Modifier,
) {
    val tint = currencyTint(colorHex)
    Row(
        modifier = modifier
            .background(tint.copy(alpha = 0.12f), RoundedCornerShape(WF.radius.pill))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = symbol, style = TextStyle(fontSize = 12.5.sp))
        Text(
            text = "$amount",
            style = TextStyle(fontSize = 13.5.sp, fontWeight = FontWeight.Bold),
            color = tint,
        )
    }
}

/**
 * A jar that fills from the bottom — the "saving toward" progress, drawn as a thing a
 * child recognises rather than a bar.
 *
 * It sits on the currency-tinted hero, never on a theme surface, so the glass is
 * `onMedia` (fixed white in both themes, exactly what that token exists for) rather than
 * a surface token that would invert underneath it.
 *
 * The percentage label deliberately does **not** follow iOS here. iOS draws it
 * `pct > 55 ? .white : WF.ink`, and `ink` in dark mode is a warm off-white — invisible on
 * the white glass. Instead the label is the currency tint while it sits on empty glass
 * and `onMedia` once the fill has risen behind it, which is legible in both themes and
 * needs no theme-dependent branch at all.
 */
@Composable
fun JarView(
    pct: Int,
    fill: Color,
    modifier: Modifier = Modifier,
) {
    val clamped = pct.coerceIn(0, 100)
    val glass = WF.colors.onMedia
    val shape = RoundedCornerShape(11.dp)
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        // Lid: a translucent wash of the same fixed white, so the jar reads as one object.
        Box(
            Modifier
                .width(26.dp)
                .height(6.dp)
                .background(glass.copy(alpha = 0.75f), RoundedCornerShape(3.dp)),
        )
        Box(
            modifier = Modifier
                .size(width = 48.dp, height = 60.dp)
                .clip(shape)
                .background(glass)
                .border(2.5.dp, glass.copy(alpha = 0.55f), shape),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    // Integer percent all the way down; only this draw call sees a float.
                    .height((60f * clamped / 100f).dp)
                    .background(fill.copy(alpha = 0.85f)),
            )
            Text(
                text = "$clamped%",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Black),
                color = if (clamped > 55) glass else fill,
            )
        }
    }
}

/**
 * The saving-toward block, shared by the shop and the person spotlight so both read
 * identically: a currency-tinted hero when a target is pinned — with a Bar/Jar toggle, a
 * **Redeem** button once it's affordable, and **Change** — or a dashed "pick one" prompt
 * when not.
 *
 * White text is correct on the hero: it is a saturated coloured fill, which is the one
 * case the `onInk` rule allows a literal white.
 */
@Composable
fun SavingTowardCard(
    saving: RewardsApi.PersonRewardOverview.SavingToward?,
    colorHex: String?,
    symbol: String,
    canPick: Boolean,
    onChange: () -> Unit,
    onRedeem: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // iOS persists this across launches with @AppStorage("waffled.savingJar"). Android
    // has no shared key/value seam in core (only the theme-specific ThemePrefsStore), so
    // the choice survives rotation and process death but not a cold start — see the
    // report note.
    var jar by rememberSaveable { mutableStateOf(false) }

    when {
        saving != null -> SavingHero(
            saving = saving,
            tint = currencyTint(colorHex),
            symbol = symbol,
            jar = jar,
            onJar = { jar = it },
            onChange = onChange,
            onRedeem = onRedeem,
            modifier = modifier,
        )

        canPick -> SavingPrompt(onChange = onChange, modifier = modifier)
    }
}

@Composable
private fun SavingHero(
    saving: RewardsApi.PersonRewardOverview.SavingToward,
    tint: Color,
    symbol: String,
    jar: Boolean,
    onJar: (Boolean) -> Unit,
    onChange: () -> Unit,
    onRedeem: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ready = RewardsMath.canAfford(have = saving.have, cost = saving.cost)
    val pct = RewardsMath.progressPercent(have = saving.have, cost = saving.cost)
    val onHero = WF.colors.onMedia
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(WF.radius.lg))
            .background(Brush.linearGradient(listOf(tint.copy(alpha = 0.92f), tint)))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "SAVING TOWARD",
                style = TextStyle(
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 0.6.sp,
                ),
                color = onHero.copy(alpha = 0.85f),
            )
            Spacer(Modifier.weight(1f))
            BarJarToggle(jar = jar, tint = tint, onJar = onJar)
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            if (jar) JarView(pct = pct, fill = tint)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(text = saving.emoji ?: "🎁", style = TextStyle(fontSize = 22.sp))
                    Text(
                        text = saving.title,
                        style = WF.type.serif(20.sp),
                        color = onHero,
                        maxLines = 2,
                    )
                }
                if (!jar) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(9.dp)
                            .clip(RoundedCornerShape(WF.radius.pill))
                            .background(onHero.copy(alpha = 0.28f)),
                    ) {
                        Box(
                            Modifier
                                // Always show a sliver, so "0 so far" still reads as a bar.
                                .fillMaxWidth(RewardsMath.progressFraction(saving.have, saving.cost).coerceAtLeast(0.02f))
                                .fillMaxSize()
                                .background(onHero),
                        )
                    }
                }
                Text(
                    text = if (ready) {
                        "Ready to redeem! 🎉"
                    } else {
                        "${saving.have} of ${saving.cost} $symbol · " +
                            "${RewardsMath.toGo(saving.have, saving.cost)} to go"
                    },
                    style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                    color = onHero.copy(alpha = 0.92f),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                if (ready) {
                    HeroPill(label = "Redeem", fill = WF.colors.primary, outlined = false, onClick = onRedeem)
                }
                HeroPill(
                    label = "Change",
                    fill = onHero.copy(alpha = 0.18f),
                    outlined = true,
                    onClick = onChange,
                )
            }
        }
    }
}

@Composable
private fun HeroPill(label: String, fill: Color, outlined: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    val onHero = WF.colors.onMedia
    Text(
        text = label,
        modifier = Modifier
            .background(fill, shape)
            .then(if (outlined) Modifier.border(1.dp, onHero.copy(alpha = 0.4f), shape) else Modifier)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = onHero,
    )
}

/**
 * The Bar/Jar segmented control.
 *
 * Hand-rolled rather than Material3's `SegmentedButton`: this one sits on a saturated
 * gradient, and the Material control draws its own outlined container from the M3 colour
 * scheme, which this app deliberately does not populate.
 */
@Composable
private fun BarJarToggle(jar: Boolean, tint: Color, onJar: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(WF.radius.pill)
    val onHero = WF.colors.onMedia
    Row(
        modifier = Modifier
            .background(onHero.copy(alpha = 0.22f), shape)
            .clip(shape)
            .padding(2.dp),
    ) {
        listOf("Bar" to false, "Jar" to true).forEach { (label, wantsJar) ->
            val on = jar == wantsJar
            Text(
                text = label,
                modifier = Modifier
                    .background(if (on) onHero else Color.Transparent, shape)
                    .clip(shape)
                    .clickable { onJar(wantsJar) }
                    .padding(horizontal = 12.dp, vertical = 5.dp),
                style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Bold),
                color = if (on) tint else onHero.copy(alpha = 0.85f),
            )
        }
    }
}

/** The dashed "pick something to save toward" prompt shown when nothing is pinned. */
@Composable
private fun SavingPrompt(onChange: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(WF.radius.lg)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(WF.colors.ai.copy(alpha = 0.07f), shape)
            // A dashed stroke would need a custom border draw; the solid 1.5dp wash reads
            // the same at this size and keeps the row on shared primitives.
            .border(1.5.dp, WF.colors.ai.copy(alpha = 0.25f), shape)
            .clip(shape)
            .clickable(onClick = onChange)
            .padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.GpsFixed,
            contentDescription = null,
            tint = WF.colors.ai,
            modifier = Modifier.size(18.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = "Pick something to save toward",
                style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                color = WF.colors.ink,
            )
            Text(
                text = "Track progress to a reward",
                style = WF.type.caption,
                color = WF.colors.ink3,
            )
        }
        Icon(
            imageVector = Icons.Filled.ChevronRight,
            contentDescription = null,
            tint = WF.colors.ink3,
            modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * A one-shot confetti burst: coloured bits fall from the top when the celebration opens.
 *
 * ### These hexes are correct and must stay literal
 *
 * `Theme.kt` documents "identity palettes that must stay distinct regardless of theme —
 * allergen badges, per-person/per-category coding, **reward confetti**" as one of the two
 * places a literal colour belongs. Confetti is a celebration, and a celebration that
 * re-tints itself to the surface it lands on stops reading as one: the whole effect is
 * many *different* colours at once. Six fixed hues (the four `FamilyColor` solids plus
 * the brand coral and gold) do that in light and dark alike. Please don't "fix" these
 * into tokens.
 *
 * Drawn on one `Canvas` rather than 26 composables — this is decoration over a sheet,
 * and 26 recomposing layout nodes for it would be a real cost.
 */
@Composable
fun ConfettiView(modifier: Modifier = Modifier) {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, animationSpec = tween(durationMillis = 1450, easing = LinearEasing))
    }

    Canvas(modifier = modifier.fillMaxSize()) {
        val pieces = 26
        repeat(pieces) { i ->
            // Staggered start, so the burst arrives as a shower rather than a curtain.
            val delay = (i % 6) * 0.05f
            val t = ((progress.value - delay) / 0.8f).coerceIn(0f, 1f)
            if (t <= 0f) return@repeat
            val x = ((i * 37 + 11) % 100) / 100f * size.width
            val y = -24f + t * (size.height + 48f)
            val piece = ConfettiColors[i % ConfettiColors.size].copy(alpha = 1f - t)
            rotate(degrees = ((i * 47) % 360).toFloat(), pivot = Offset(x + 3.5f, y + 5.5f)) {
                drawRoundRect(
                    color = piece,
                    topLeft = Offset(x, y),
                    size = Size(7f, 11f),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f, 2f),
                )
            }
        }
    }
}

/** See [ConfettiView] — a fixed identity palette, deliberately not tokenised. */
private val ConfettiColors = listOf(
    Color(0xFFEC6049), // coral
    Color(0xFF8A5CF0), // violet
    Color(0xFFF3A93B), // gold
    Color(0xFF25A368), // green
    Color(0xFF2F7FED), // blue
    Color(0xFFE0548B), // pink
)

/**
 * A boxed single-line text field.
 *
 * Hand-rolled on `BasicTextField` for the same reason the Photos module does it:
 * Material3's `TextField`/`OutlinedTextField` draw their own container, indicator line
 * and floating label, all of which contradict `wfField` — this repo's single source for
 * field chrome. The duplication between feature modules is noted in the report; this
 * belongs in `core:design`.
 */
@Composable
internal fun RewardTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    fill: Color = WF.colors.panel,
    fontSize: androidx.compose.ui.unit.TextUnit = 16.sp,
    textAlign: TextAlign? = null,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions =
        androidx.compose.foundation.text.KeyboardOptions.Default,
) {
    Box(
        modifier = modifier
            .background(fill, RoundedCornerShape(WF.radius.md))
            .clip(RoundedCornerShape(WF.radius.md))
            .padding(horizontal = 13.dp, vertical = 12.dp),
    ) {
        androidx.compose.foundation.text.BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            textStyle = TextStyle(fontSize = fontSize, color = WF.colors.ink, textAlign = textAlign ?: TextAlign.Start),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(WF.colors.primary),
            keyboardOptions = keyboardOptions,
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        modifier = Modifier.fillMaxWidth(),
                        style = TextStyle(fontSize = fontSize, textAlign = textAlign ?: TextAlign.Start),
                        color = WF.colors.ink3,
                    )
                }
                inner()
            },
        )
    }
}
