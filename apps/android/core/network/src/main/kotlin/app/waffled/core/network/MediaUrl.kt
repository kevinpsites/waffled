package app.waffled.core.network

/**
 * Resolving media paths returned by the API.
 *
 * Paths are usually relative to the server origin (`/media/ab/cd.jpg`) but may already be
 * absolute if object storage hands back a full URL. Shared by every image-bearing
 * feature — Photos, Meals, Pantry, chore proofs, the screensaver.
 *
 * Twin of `MediaURL` in `apps/ios/.../Sync/MediaUpload.swift`.
 */
object MediaUrl {

    /** Absolute URL for [path], or null if there is nothing to show. */
    fun resolve(path: String?, baseUrl: String): String? {
        val p = path?.trim().orEmpty()
        if (p.isEmpty()) return null

        if (p.startsWith("http://", ignoreCase = true) || p.startsWith("https://", ignoreCase = true)) {
            return p
        }
        return baseUrl.trimEnd('/') + "/" + p.removePrefix("/")
    }

    /**
     * The key to cache a media item under.
     *
     * **Cache on the storage path, never on the resolved URL.** Signed URLs carry an
     * expiry, so keying on them means the key changes every load and the cache never
     * hits — which is exactly how expiring URLs broke the photo screensaver on the web.
     * A signed URL is an expiry mechanism, not an identity.
     */
    fun cacheKey(path: String?): String? =
        path?.trim()?.substringBefore('?')?.takeIf { it.isNotEmpty() }
}
