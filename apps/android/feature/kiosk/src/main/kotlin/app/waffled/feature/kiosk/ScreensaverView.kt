package app.waffled.feature.kiosk

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.colorFromHex
import app.waffled.core.network.MediaUrl
import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.photos.PhotosApi
import app.waffled.feature.settingshousehold.SettingsHouseholdApi.DisplayConfig
import app.waffled.feature.today.TodayApi
import coil3.SingletonImageLoader
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Layers the idle screensaver over [content] (the kiosk root). A pass-through pointer
 * watcher feeds the idle clock without consuming touches. While the saver is up the
 * screen stays on — it IS the screensaver.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KioskScreensaverHost(
    model: ScreensaverModel,
    isShared: Boolean,
    events: List<SyncedEvent>,
    zone: ZoneId,
    baseUrl: String,
    onReturnToPicker: () -> Unit,
    modifier: Modifier = Modifier,
    motion: Boolean = true,
    content: @Composable () -> Unit,
) {
    val state by model.state.collectAsState()
    // Dialogs and sheets are separate windows whose touches never reach this root, and
    // the saver would draw beneath them — so hold the idle clock while one is focused.
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    val imeVisible = WindowInsets.isImeVisible
    val hold by rememberUpdatedState(!windowFocused || imeVisible)
    val focus = LocalFocusManager.current
    val view = LocalView.current

    LaunchedEffect(model) { model.load() }
    // Config rarely changes and weather is hourly, so 15 min is plenty; nothing worth
    // fetching overnight.
    LaunchedEffect(model) {
        while (true) {
            delay(15 * 60_000L)
            if (!model.state.value.dimmed) model.load()
        }
    }
    // A 10s cadence: the saver may appear up to 10s late, and the device sleeps 10x more.
    LaunchedEffect(model, zone) {
        while (true) {
            model.tick(Instant.now(), zone, hold)
            delay(10_000)
        }
    }
    DisposableEffect(state.showing) {
        view.keepScreenOn = state.showing
        if (state.showing) focus.clearFocus(force = true)
        onDispose { view.keepScreenOn = false }
    }

    Box(
        modifier
            .fillMaxSize()
            .pointerInput(model) {
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent(PointerEventPass.Initial)
                        model.ping()
                    }
                }
            },
    ) {
        content()
        val cfg = state.config
        AnimatedVisibility(visible = state.showing && cfg != null, enter = fadeIn(tween(450)), exit = fadeOut(tween(450))) {
            if (cfg != null) {
                ScreensaverView(
                    content = if (cfg.content == "photos") "photos" else "clock",
                    photos = state.photos,
                    weather = state.weather,
                    nextEvent = remember(events, state.showing) { Screensaver.nextEvent(events, Instant.now()) },
                    zone = zone,
                    dimmed = state.dimmed,
                    interval = cfg.photoInterval,
                    baseUrl = baseUrl,
                    motion = motion,
                    onWake = {
                        val toPicker = Screensaver.wakeReturnsToPicker(cfg, isShared)
                        model.wake()
                        if (toPicker) onReturnToPicker()
                    },
                )
            }
        }
    }
}

/**
 * The full-screen preview Settings → Display & Kiosk offers ("Preview"): the saver as
 * configured right now, tap anywhere to close. Pass the panel's current (maybe unsaved)
 * [config] so the preview follows edits.
 */
@Composable
fun ScreensaverPreview(
    config: DisplayConfig,
    fetchPhotos: suspend () -> List<PhotosApi.Photo>,
    fetchWeather: suspend () -> TodayApi.Weather?,
    events: List<SyncedEvent>,
    zone: ZoneId,
    baseUrl: String,
    onDismiss: () -> Unit,
    motion: Boolean = true,
) {
    var photos by remember { mutableStateOf<List<PhotosApi.Photo>>(emptyList()) }
    var weather by remember { mutableStateOf<TodayApi.Weather?>(null) }
    LaunchedEffect(Unit) {
        weather = runCatching { fetchWeather() }.getOrNull()
        photos = runCatching { fetchPhotos() }.getOrDefault(emptyList())
    }
    val played = remember(photos, config.photoSource, config.photoAlbum, config.photoShuffle) { Screensaver.photos(photos, config) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        ScreensaverView(
            content = if (config.content == "photos") "photos" else "clock",
            photos = played,
            weather = weather,
            nextEvent = remember(events) { Screensaver.nextEvent(events, Instant.now()) },
            zone = zone,
            dimmed = false,
            interval = config.photoInterval,
            baseUrl = baseUrl,
            motion = motion,
            onWake = onDismiss,
        )
    }
}

/**
 * The full-screen family-display screensaver: cross-fading photos with a slow Ken-Burns
 * drift (or a calm dark gradient in clock mode), overlaid with a big clock, date ·
 * weather, the next event, the photo's album and a wake hint. [bare] drops the overlays
 * for a plain slideshow. Always dark by design — the plan's one theme exception.
 */
@Composable
fun ScreensaverView(
    content: String,
    photos: List<PhotosApi.Photo>,
    weather: TodayApi.Weather?,
    nextEvent: SyncedEvent?,
    zone: ZoneId,
    dimmed: Boolean,
    interval: Int,
    baseUrl: String,
    onWake: () -> Unit,
    modifier: Modifier = Modifier,
    bare: Boolean = false,
    motion: Boolean = true,
) {
    val photoMode = content == "photos" && photos.isNotEmpty()
    var idx by remember(photos) { mutableIntStateOf(0) }
    var prevIdx by remember(photos) { mutableIntStateOf(0) }
    var now by remember { mutableStateOf(Instant.now()) }
    val perPhoto = Screensaver.perPhotoSeconds(interval)
    val context = LocalContext.current

    // One heartbeat drives both: the clock re-renders only on a minute rollover.
    LaunchedEffect(photos, perPhoto) {
        var elapsed = 0
        while (true) {
            delay(1_000)
            val t = Instant.now()
            if (t.epochSecond / 60 != now.epochSecond / 60) now = t
            elapsed += 1
            if (elapsed >= perPhoto) {
                elapsed = 0
                if (photoMode && photos.size > 1) {
                    val next = Screensaver.nextIndex(idx, photos.size)
                    // Warm the photo after next so its turn is flash-free too.
                    prefetch(context, photos[Screensaver.nextIndex(next, photos.size)], baseUrl)
                    prevIdx = idx
                    idx = next
                }
            }
        }
    }
    LaunchedEffect(photos) { photos.take(2).forEach { prefetch(context, it, baseUrl) } }

    val locale = Locale.getDefault()
    val timeFmt = remember(zone, locale) { DateTimeFormatter.ofPattern("h:mm", locale).withZone(zone) }
    val dateFmt = remember(zone, locale) { DateTimeFormatter.ofPattern("EEEE, MMMM d", locale).withZone(zone) }

    Box(
        modifier
            .fillMaxSize()
            .background(ClockTop)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onWake),
    ) {
        if (photoMode) {
            // The outgoing photo sits underneath, static, so the incoming one fades in
            // over a real image rather than a blank frame.
            SlidePhoto(photos[prevIdx % photos.size], baseUrl, motion = false, durationMs = 0, fadeIn = false)
            androidx.compose.runtime.key(idx) {
                SlidePhoto(photos[idx % photos.size], baseUrl, motion = motion, durationMs = (perPhoto * 1000) + 1200, fadeIn = idx != prevIdx)
            }
        } else {
            Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(ClockTop, ClockBottom))))
        }

        if (!bare) {
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(
                        0f to Color.Black.copy(alpha = 0.45f),
                        0.33f to Color.Transparent,
                        0.66f to Color.Transparent,
                        1f to Color.Black.copy(alpha = 0.5f),
                    ),
                ),
            )
            Column(Modifier.fillMaxSize().padding(start = 54.dp, end = 54.dp, top = 46.dp, bottom = 40.dp)) {
                Text(timeFmt.format(now), style = WF.type.serif(112.sp).copy(shadow = shadow(0.4f, 16f, 2f)), color = WF.colors.onMedia)
                Text(
                    Screensaver.dateLine(dateFmt.format(now), weather),
                    style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold, shadow = shadow(0.4f, 12f, 1f)),
                    color = WF.colors.onMedia.copy(alpha = 0.95f),
                )
                Spacer(Modifier.weight(1f))
                Row(verticalAlignment = Alignment.Bottom) {
                    val album = if (photoMode) Screensaver.albumLabel(photos[idx % photos.size]) else null
                    Box(Modifier.weight(1f)) {
                        album?.let {
                            Text(
                                it,
                                style = WF.type.serif(30.sp).copy(shadow = shadow(0.45f, 14f, 1f)),
                                color = WF.colors.onMedia,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Screensaver.nextEventLine(nextEvent) { timeFmt.format(it) }?.let {
                            Text(
                                it,
                                style = TextStyle(fontSize = 19.sp, fontWeight = FontWeight.ExtraBold, shadow = shadow(0.45f, 12f, 1f)),
                                color = WF.colors.onMedia,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        WakeHint()
                    }
                }
            }
        } else {
            Box(Modifier.align(Alignment.BottomEnd).padding(end = 54.dp, bottom = 40.dp)) { WakeHint() }
        }
        if (dimmed) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.62f)))
    }
}

@Composable
private fun WakeHint() {
    Text(
        "Tap anywhere to wake",
        Modifier.background(WF.colors.scrim, CircleShape).padding(horizontal = 12.dp, vertical = 7.dp),
        style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold),
        color = WF.colors.onMedia.copy(alpha = 0.85f),
    )
}

/**
 * One full-screen photo through the shared Coil loader, cached on the STORAGE key (a
 * signed URL expires, which is how the web screensaver once lost its cache).
 */
@Composable
private fun SlidePhoto(photo: PhotosApi.Photo, baseUrl: String, motion: Boolean, durationMs: Int, fadeIn: Boolean) {
    val scale = remember(photo.id) { Animatable(1f) }
    val alpha = remember(photo.id) { Animatable(if (fadeIn) 0f else 1f) }
    LaunchedEffect(photo.id) {
        if (fadeIn) alpha.animateTo(1f, tween(1100, easing = FastOutSlowInEasing))
    }
    LaunchedEffect(photo.id, motion) {
        if (motion) scale.animateTo(1.08f, tween(durationMs, easing = FastOutSlowInEasing))
    }
    val url = MediaUrl.resolve(photo.imageUrl, baseUrl)
    Box(Modifier.fillMaxSize().clipToBounds().graphicsLayer { this.alpha = alpha.value }) {
        if (url == null) {
            // The photo's own colour is data; the fallback sky blue mirrors iOS.
            val c = colorFromHex(photo.colorHex) ?: Color(0xFF7FC1E8)
            Box(
                Modifier.fillMaxSize().background(Brush.linearGradient(listOf(c, c.copy(alpha = 0.7f)))),
                contentAlignment = Alignment.Center,
            ) { Text(photo.emoji ?: "🖼️", style = TextStyle(fontSize = 160.sp)) }
        } else {
            AsyncImage(
                model = WaffledImages.request(LocalContext.current, url, MediaUrl.cacheKey(photo.imageUrl)),
                contentDescription = Screensaver.albumLabel(photo),
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = scale.value; scaleY = scale.value },
            )
        }
    }
}

private fun prefetch(context: android.content.Context, photo: PhotosApi.Photo, baseUrl: String) {
    val url = MediaUrl.resolve(photo.imageUrl, baseUrl) ?: return
    SingletonImageLoader.get(context).enqueue(WaffledImages.request(context, url, MediaUrl.cacheKey(photo.imageUrl)))
}

private fun shadow(alpha: Float, blur: Float, y: Float) = Shadow(Color.Black.copy(alpha = alpha), Offset(0f, y), blur)

// Clock-mode backdrop: deliberately theme-independent (the screensaver is always dark),
// the same literals as iOS ScreensaverView.
private val ClockTop = Color(0xFF2B2B2B)
private val ClockBottom = Color(0xFF161616)
