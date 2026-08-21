package app.waffled.core.design

import android.content.Context
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import coil3.request.crossfade
import okio.Path.Companion.toOkioPath

/**
 * The one image loader the whole app shares.
 *
 * This lives in `core:design` rather than `app` deliberately: the configuration is a
 * cross-cutting concern that every image-bearing feature depends on, but **no feature
 * module owns `app`** — so if it lived there, a feature agent could neither set it up nor
 * rely on it. `app` installs this at startup; features just use `AsyncImage`.
 *
 * The memory cache is the point. A naive loader re-fetches and re-decodes on every cell
 * recreation — every scroll, every search keystroke — which produced multi-second lag in
 * lazy grids on iOS. A real memory cache serves repeat cells synchronously.
 */
object WaffledImages {

    /** Fraction of the app's available memory to spend on decoded bitmaps. */
    private const val MEMORY_FRACTION = 0.25

    fun loader(context: Context): ImageLoader = ImageLoader.Builder(context)
        .memoryCache {
            MemoryCache.Builder()
                .maxSizePercent(context as PlatformContext, MEMORY_FRACTION)
                .build()
        }
        .diskCache {
            DiskCache.Builder()
                .directory(context.cacheDir.resolve("waffled_images").toOkioPath())
                .maxSizeBytes(256L * 1024 * 1024)
                .build()
        }
        .memoryCachePolicy(CachePolicy.ENABLED)
        .diskCachePolicy(CachePolicy.ENABLED)
        .crossfade(true)
        .build()

    /**
     * Build a request keyed on the **storage path**, not the resolved URL.
     *
     * Signed URLs carry an expiry, so keying the cache on them means the key changes
     * every load and the cache never hits — the bug that broke the photo screensaver on
     * the web. Pass the stable path as [cacheKey] and the (possibly signed) absolute URL
     * as [url]. Use this rather than handing a bare URL to `AsyncImage`.
     */
    fun request(context: Context, url: String?, cacheKey: String?): ImageRequest =
        ImageRequest.Builder(context)
            .data(url)
            .apply {
                if (cacheKey != null) {
                    memoryCacheKey(cacheKey)
                    diskCacheKey(cacheKey)
                }
            }
            .build()
}
