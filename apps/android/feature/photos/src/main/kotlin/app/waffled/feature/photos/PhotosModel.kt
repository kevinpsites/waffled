package app.waffled.feature.photos

import androidx.compose.runtime.Immutable
import app.waffled.core.network.MediaUrl
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.network.RestDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.time.ZoneId

/**
 * One row on the wall: the wire photo plus everything the grid would otherwise have to
 * compute per frame.
 *
 * Resolving the media URL and formatting the date **at load time** is the point. A lazy
 * grid recomposes constantly, and doing either in the tile is the documented iOS
 * performance trap; here the tile only reads fields.
 */
@Immutable
data class PhotoRow(
    val photo: PhotosApi.Photo,
    /** Absolute URL for the stored blob, or null for the emoji-tile fallback. */
    val resolvedImageUrl: String?,
    /**
     * Coil's cache key — the storage PATH, never the (possibly signed) URL. A signed URL
     * carries an expiry, so keying on it means the key changes every load and the cache
     * never hits. That is exactly how expiring URLs broke the photo screensaver on web.
     */
    val imageCacheKey: String?,
    /** "Sat, Jul 4, 2026", formatted once here rather than per recomposition. */
    val dateLabel: String?,
) {
    val id: String get() = photo.id
    val caption: String get() = photo.caption
    val memory: String? get() = photo.memory
    val isFavorite: Boolean get() = photo.isFavorite
    val emoji: String? get() = photo.emoji
    val colorHex: String? get() = photo.colorHex
}

/**
 * REST-backed state for the Photos wall — the port of
 * `apps/ios/.../Photos/PhotosModel.swift`.
 *
 * Photos are not a PowerSync table, so the grid loads over the API on appear, on
 * pull-to-refresh, and after every add / edit / delete.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule.
 */
class PhotosModel(
    /** Public so the add / detail sheets can issue their own writes against one slice. */
    val api: PhotosApi,
    private val baseUrl: String,
    private val zone: ZoneId = ZoneId.systemDefault(),
    /**
     * Bumped after every write so OTHER REST-backed screens re-fetch — a Today photo
     * count, say. Photos aren't synced, so nothing else would ever hear about a change.
     * Optional only so a test can leave it out.
     */
    private val refreshBus: RefreshBus? = null,
) {

    private val domain = RestDomain<List<PhotoRow>>()

    private val _loading = MutableStateFlow(false)
    private val _error = MutableStateFlow(false)
    private val loadGeneration = java.util.concurrent.atomic.AtomicInteger(0)

    /** Emitted state for the screen — the rows, whether we've loaded, and the flags. */
    val state: StateFlow<RestDomain.Snapshot<List<PhotoRow>>> = domain.state
    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    val photos: List<PhotoRow> get() = domain.value.orEmpty()
    val loaded: Boolean get() = domain.loaded
    val loading: Boolean get() = _loading.value
    val error: Boolean get() = _error.value

    /** The distinct album labels on the current wall, for the add / edit pickers. */
    val albums: List<String>
        get() = photos.mapNotNull { it.memory?.takeIf(String::isNotEmpty) }.distinct().sorted()

    /** How many photos share an album — the detail sheet's "view all" line. */
    fun countInAlbum(album: String): Int = photos.count { it.memory == album }

    /** The wall, or just one album. Drives the grid. */
    fun shown(album: String?): List<PhotoRow> =
        if (album == null) photos else photos.filter { it.memory == album }

    // ---- loading ---------------------------------------------------------------

    suspend fun load() {
        // The last load STARTED wins: a slow older fetch (say, from before a write) must
        // not land on top of a newer one.
        val generation = loadGeneration.incrementAndGet()
        _loading.value = true
        try {
            val rows = runCatching { api.list().map(::toRow) }
            if (generation != loadGeneration.get()) return
            // RestDomain contract: a real list (even an empty one) replaces; null means
            // the fetch FAILED — keep what we had so a flaky network never blanks the
            // wall, but still mark it loaded so we don't sit on a spinner forever.
            domain.apply(rows.getOrNull())
            _error.value = rows.isFailure
        } finally {
            if (generation == loadGeneration.get()) _loading.value = false
        }
    }

    /**
     * Tell the rest of the app a photo changed. Call after any write — including the
     * ones the add / detail sheets issue directly against [api].
     */
    fun invalidate() {
        refreshBus?.bump(RefreshDomain.Photos)
    }

    private fun toRow(photo: PhotosApi.Photo) = PhotoRow(
        photo = photo,
        resolvedImageUrl = MediaUrl.resolve(photo.imageUrl, baseUrl),
        imageCacheKey = MediaUrl.cacheKey(photo.imageUrl),
        dateLabel = PhotosFormat.dateLabel(photo.takenAt, photo.createdAt, zone),
    )

    // ---- bulk actions (multi-select) -------------------------------------------

    /**
     * Move [ids] into [album]; a null or blank album removes them from any album.
     *
     * Patches each over the per-photo endpoint, then reloads. Returns false if any one
     * failed — the wall still reloads, so whatever did land is visible.
     */
    suspend fun move(ids: Set<String>, album: String?): Boolean {
        val trimmed = album?.trim().orEmpty()
        // An explicit null CLEARS the album; omitting the key would leave it unchanged.
        val value = if (trimmed.isEmpty()) JsonNull else JsonPrimitive(trimmed)
        var ok = true
        for (id in ids) {
            val patched = runCatching { api.update(id, buildJsonObject { put("memory", value) }) }
            if (patched.isFailure) ok = false
        }
        invalidate()
        load()
        return ok
    }

    /** Soft-delete [ids], then reload. Returns false if any one failed. */
    suspend fun delete(ids: Set<String>): Boolean {
        var ok = true
        for (id in ids) {
            if (runCatching { api.delete(id) }.isFailure) ok = false
        }
        invalidate()
        load()
        return ok
    }
}
