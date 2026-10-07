package app.waffled.feature.kiosk

import app.waffled.core.sync.SyncedEvent
import app.waffled.feature.photos.PhotosApi
import app.waffled.feature.settingshousehold.SettingsHouseholdApi.DisplayConfig
import app.waffled.feature.today.TodayApi
import kotlinx.coroutines.test.runTest
import java.time.Instant
import java.time.ZoneId
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The idle screensaver's rules — iOS `ScreensaverModel` + `screensaverPhotos`. */
class ScreensaverModelTest {

    private val utc = ZoneId.of("UTC")
    private fun at(iso: String) = Instant.parse(iso)
    private fun photo(id: String, fav: Boolean = false, memory: String? = null, caption: String = "") =
        PhotosApi.Photo(id = id, isFavorite = fav, memory = memory, caption = caption)

    // ---- night window ----

    @Test fun nightWindowWithinADay() {
        val nd = DisplayConfig.NightDim(enabled = true, start = "13:00", end = "15:00")
        assertTrue(Screensaver.inNightWindow(nd, at("2026-10-07T14:00:00Z"), utc))
        assertFalse(Screensaver.inNightWindow(nd, at("2026-10-07T15:00:00Z"), utc))
        assertTrue(Screensaver.inNightWindow(nd, at("2026-10-07T13:00:00Z"), utc))
    }

    @Test fun nightWindowWrapsOvernight() {
        val nd = DisplayConfig.NightDim(enabled = true, start = "21:00", end = "07:00")
        assertTrue(Screensaver.inNightWindow(nd, at("2026-10-07T23:30:00Z"), utc))
        assertTrue(Screensaver.inNightWindow(nd, at("2026-10-07T03:00:00Z"), utc))
        assertFalse(Screensaver.inNightWindow(nd, at("2026-10-07T12:00:00Z"), utc))
        assertFalse(Screensaver.inNightWindow(nd, at("2026-10-07T07:00:00Z"), utc))
    }

    @Test fun nightWindowUsesTheHouseholdZone() {
        val nd = DisplayConfig.NightDim(enabled = true, start = "21:00", end = "07:00")
        // 03:00Z is 23:00 the evening before in New York.
        assertTrue(Screensaver.inNightWindow(nd, at("2026-10-07T03:00:00Z"), ZoneId.of("America/New_York")))
        assertFalse(Screensaver.inNightWindow(nd, at("2026-10-07T15:00:00Z"), ZoneId.of("America/New_York")))
    }

    @Test fun disabledNightWindowNeverDims() {
        val nd = DisplayConfig.NightDim(enabled = false, start = "00:00", end = "23:59")
        assertFalse(Screensaver.inNightWindow(nd, at("2026-10-07T12:00:00Z"), utc))
    }

    // ---- photo selection ----

    @Test fun photoSourcePicksAllFavouritesOrOneAlbum() {
        val photos = listOf(photo("1", fav = true, memory = "Beach"), photo("2"), photo("3", memory = "Beach"))
        val noShuffle = DisplayConfig(photoShuffle = false)
        assertEquals(listOf("1", "2", "3"), Screensaver.photos(photos, noShuffle).map { it.id })
        assertEquals(listOf("1"), Screensaver.photos(photos, noShuffle.copy(photoSource = "favorites")).map { it.id })
        assertEquals(listOf("1", "3"), Screensaver.photos(photos, noShuffle.copy(photoSource = "album", photoAlbum = "Beach")).map { it.id })
        // An album source with no album chosen plays everything.
        assertEquals(3, Screensaver.photos(photos, noShuffle.copy(photoSource = "album", photoAlbum = null)).size)
    }

    @Test fun shuffleIsDrivenByTheInjectedRandom() {
        val photos = (1..20).map { photo("$it") }
        val a = Screensaver.photos(photos, DisplayConfig(photoShuffle = true), Random(7))
        val b = Screensaver.photos(photos, DisplayConfig(photoShuffle = true), Random(7))
        assertEquals(a, b)
        assertEquals(photos.toSet(), a.toSet())
        assertTrue(a != photos)
    }

    // ---- idle tick ----

    private fun model(cfg: DisplayConfig?, start: Instant = at("2026-10-07T12:00:00Z")): ScreensaverModel {
        var now = start
        return ScreensaverModel(
            fetchConfig = { cfg ?: error("offline") },
            fetchWeather = { TodayApi.Weather(configured = false) },
            fetchPhotos = { listOf(photo("p")) },
            clock = { now },
        )
    }

    @Test fun showsAfterTheIdleDelayAndWakesOnTap() = runTest {
        val m = model(DisplayConfig(screensaverMinutes = 2, content = "clock"))
        m.load()
        m.tick(at("2026-10-07T12:01:59Z"), utc)
        assertFalse(m.state.value.showing)
        m.tick(at("2026-10-07T12:02:00Z"), utc)
        assertTrue(m.state.value.showing)
        m.wake(at("2026-10-07T12:05:00Z"))
        assertFalse(m.state.value.showing)
        m.tick(at("2026-10-07T12:06:00Z"), utc)
        assertFalse(m.state.value.showing)
    }

    @Test fun reEnteringTheShellRestartsTheIdleClock() = runTest {
        // The model outlives the shell: time parked on the profile picker must not count,
        // or the saver drops the instant someone claims a profile.
        val m = model(DisplayConfig(screensaverMinutes = 2, content = "clock"))
        m.load()
        m.resetIdle(at("2026-10-07T12:30:00Z"))
        m.tick(at("2026-10-07T12:30:01Z"), utc)
        assertFalse(m.state.value.showing)
    }

    @Test fun activityResetsTheIdleClockButNotWhileShowing() = runTest {
        val m = model(DisplayConfig(screensaverMinutes = 1, content = "clock"))
        m.load()
        m.ping(at("2026-10-07T12:00:50Z"))
        m.tick(at("2026-10-07T12:01:10Z"), utc)
        assertFalse(m.state.value.showing)
        m.tick(at("2026-10-07T12:01:50Z"), utc)
        assertTrue(m.state.value.showing)
        // A stray ping must not pre-empt the wake tap.
        m.ping(at("2026-10-07T12:02:00Z"))
        assertTrue(m.state.value.showing)
    }

    @Test fun aModalOrKeyboardHoldsTheIdleClock() = runTest {
        val m = model(DisplayConfig(screensaverMinutes = 1, content = "clock"))
        m.load()
        m.tick(at("2026-10-07T12:05:00Z"), utc, hold = true)
        assertFalse(m.state.value.showing)
        // The hold restarted the clock, so the saver waits a FULL delay after it lifts.
        m.tick(at("2026-10-07T12:05:30Z"), utc)
        assertFalse(m.state.value.showing)
        m.tick(at("2026-10-07T12:06:00Z"), utc)
        assertTrue(m.state.value.showing)
    }

    @Test fun contentOffNeverShowsAndHidesAnOpenSaver() = runTest {
        val m = model(DisplayConfig(screensaverMinutes = 1, content = "off"))
        m.load()
        m.tick(at("2026-10-07T13:00:00Z"), utc)
        assertFalse(m.state.value.showing)
        assertFalse(m.state.value.dimmed)
    }

    @Test fun noConfigMeansNoSaver() = runTest {
        val m = model(null)
        m.load()
        m.tick(at("2026-10-07T13:00:00Z"), utc)
        assertFalse(m.state.value.showing)
    }

    @Test fun nightDimFollowsTheWindowEvenWhileHidden() = runTest {
        val m = model(DisplayConfig(content = "clock", nightDim = DisplayConfig.NightDim(true, "11:00", "13:00")))
        m.load()
        m.tick(at("2026-10-07T12:00:30Z"), utc)
        assertTrue(m.state.value.dimmed)
        m.tick(at("2026-10-07T14:00:00Z"), utc)
        assertFalse(m.state.value.dimmed)
    }

    @Test fun photosAreOnlyFetchedInPhotosMode() = runTest {
        var fetched = 0
        val clockMode = ScreensaverModel(
            fetchConfig = { DisplayConfig(content = "clock") },
            fetchWeather = { null },
            fetchPhotos = { fetched++; listOf(photo("p")) },
        )
        clockMode.load()
        assertEquals(0, fetched)
        assertTrue(clockMode.state.value.photos.isEmpty())

        val photoMode = ScreensaverModel(
            fetchConfig = { DisplayConfig(content = "photos", photoShuffle = false) },
            fetchWeather = { null },
            fetchPhotos = { fetched++; listOf(photo("p")) },
        )
        photoMode.load()
        assertEquals(1, fetched)
        assertEquals(listOf("p"), photoMode.state.value.photos.map { it.id })
    }

    @Test fun wakeReturnsToThePickerOnlyOnASharedKioskThatAsksForIt() {
        assertTrue(Screensaver.wakeReturnsToPicker(DisplayConfig(returnToPicker = true), isShared = true))
        assertFalse(Screensaver.wakeReturnsToPicker(DisplayConfig(returnToPicker = true), isShared = false))
        assertFalse(Screensaver.wakeReturnsToPicker(DisplayConfig(returnToPicker = false), isShared = true))
        assertFalse(Screensaver.wakeReturnsToPicker(null, isShared = true))
    }

    // ---- chrome text ----

    @Test fun dateLineAppendsConfiguredWeather() {
        assertEquals("Wednesday, October 7", Screensaver.dateLine("Wednesday, October 7", null))
        assertEquals("Wednesday, October 7", Screensaver.dateLine("Wednesday, October 7", TodayApi.Weather(configured = false, tempF = 70.0)))
        assertEquals(
            "Wednesday, October 7 · ☀️ 72° · Sunny",
            Screensaver.dateLine("Wednesday, October 7", TodayApi.Weather(configured = true, tempF = 71.6, emoji = "☀️", label = "Sunny")),
        )
        assertEquals("Wednesday, October 7 · 72°", Screensaver.dateLine("Wednesday, October 7", TodayApi.Weather(configured = true, tempF = 71.6)))
    }

    @Test fun albumLabelPrefersTheAlbumThenTheCaption() {
        assertEquals("Beach", Screensaver.albumLabel(photo("1", memory = "Beach", caption = "x")))
        assertEquals("Sunset", Screensaver.albumLabel(photo("1", caption = "Sunset")))
        assertNull(Screensaver.albumLabel(photo("1")))
        assertNull(Screensaver.albumLabel(photo("1", memory = "")))
    }

    private fun event(id: String, title: String, starts: String?, allDay: Boolean = false) =
        SyncedEvent(id = id, householdId = "h", title = title, startsAt = starts, allDay = allDay)

    @Test fun nextEventIsTheSoonestUpcoming() {
        val now = at("2026-10-07T12:00:00Z")
        val events = listOf(
            event("past", "Past", "2026-10-07T11:00:00Z"),
            event("later", "Later", "2026-10-08T09:00:00Z"),
            event("soon", "Soon", "2026-10-07T15:00:00Z"),
            event("none", "No time", null),
        )
        assertEquals("soon", Screensaver.nextEvent(events, now)?.id)
        assertNull(Screensaver.nextEvent(listOf(events[0]), now))
    }

    @Test fun nextEventLineShowsTheTimeUnlessAllDay() {
        val fmt: (Instant) -> String = { "3:00" }
        assertEquals("Next: Soccer · 3:00", Screensaver.nextEventLine(event("1", "Soccer", "2026-10-07T15:00:00Z"), fmt))
        assertEquals("Next: Trip", Screensaver.nextEventLine(event("1", "Trip", "2026-10-07T00:00:00Z", allDay = true), fmt))
        assertNull(Screensaver.nextEventLine(null, fmt))
    }

    @Test fun photosAdvanceOnlyWhenThereIsMoreThanOne() {
        assertEquals(1, Screensaver.nextIndex(0, 3))
        assertEquals(0, Screensaver.nextIndex(2, 3))
        assertEquals(0, Screensaver.nextIndex(0, 1))
        assertEquals(0, Screensaver.nextIndex(0, 0))
        assertEquals(3, Screensaver.perPhotoSeconds(1))
        assertEquals(8, Screensaver.perPhotoSeconds(8))
    }
}
