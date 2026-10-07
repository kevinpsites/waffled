package app.waffled.feature.family

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Port of the Family hub cases in RestDataStateTests.swift (RestBackedSurfaceStateTests):
// partial failure is never "empty", disabled modules are neither fetched nor counted, and
// a scope change never shows the previous account's data.
class FamilyHubModelTest {

    private class Calls {
        val names = mutableListOf<String>()
        fun count(name: String) = names.count { it == name }
    }

    private fun photo(id: String, memory: String? = null) =
        FamilyApi.PhotoRef(id = id, memory = memory)

    private fun model(
        calls: Calls = Calls(),
        chores: suspend () -> List<FamilyApi.PersonChores> = { calls.names += "chores"; emptyList() },
        goals: suspend () -> List<FamilyApi.GoalRef> = { calls.names += "goals"; emptyList() },
        stars: suspend () -> List<FamilyApi.FamilyStars> = { calls.names += "rewards"; emptyList() },
        lists: suspend () -> List<FamilyApi.ListRef> = { calls.names += "lists"; emptyList() },
        photos: suspend () -> List<FamilyApi.PhotoRef> = { calls.names += "photos"; emptyList() },
    ) = FamilyHubModel(chores, goals, stars, lists, photos)

    @Test fun familyHubDoesNotCallPartialFailureEmpty() = runTest {
        val m = model(chores = { error("rejected") })
        m.load(scope = "a", modules = FamilyRestModules.ALL)

        assertEquals("Couldn’t load", m.state.value.choresSubtitle)
        assertFalse(m.state.value.isAuthoritative)
        assertFalse(m.state.value.isEmpty)
    }

    @Test fun disabledFamilyModulesAreNeitherFetchedNorAggregated() = runTest {
        val calls = Calls()
        val m = model(calls)
        m.load(scope = "a", modules = FamilyRestModules.NONE)

        assertEquals(listOf("photos"), calls.names)
        assertTrue(m.state.value.isEmpty)
        assertTrue(m.state.value.isAuthoritative)
    }

    @Test fun disabledRewardsDoesNotFetchTheHiddenRewardsFeed() = runTest {
        val calls = Calls()
        val m = model(calls)
        m.load(
            scope = "a",
            modules = FamilyRestModules(chores = true, goals = false, rewards = false, lists = false),
        )

        assertEquals(1, calls.count("chores"))
        assertEquals(0, calls.count("rewards"))
        assertEquals(1, calls.count("photos"))
        assertTrue(m.state.value.isAuthoritative)
    }

    @Test fun disablingAFailedFamilyModuleRemovesItsErrorFromTheScreenState() = runTest {
        val calls = Calls()
        val m = model(calls, chores = { calls.names += "chores"; error("rejected") })
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        assertFalse(m.state.value.isAuthoritative)

        m.load(scope = "a", modules = FamilyRestModules.NONE)

        assertTrue(m.state.value.isEmpty)
        assertTrue(m.state.value.isAuthoritative)
        assertEquals(1, calls.count("chores"))
    }

    @Test fun familyScopeChangeClearsConfirmedValuesBeforeANewScopeFails() = runTest {
        var photos: suspend () -> List<FamilyApi.PhotoRef> = { listOf(photo("tenant-a-photo")) }
        val m = model(photos = { photos() })
        // Two distinct keys that would stringify alike — scope is compared by identity.
        val scopeA = Any()
        val scopeB = Any()

        m.load(scope = scopeA, modules = FamilyRestModules.NONE)
        assertEquals(1, m.state.value.photosCount)
        photos = { error("rejected") }

        m.load(scope = scopeB, modules = FamilyRestModules.NONE)

        assertEquals(0, m.state.value.photosCount)
        assertFalse(m.state.value.isAuthoritative)
        assertEquals("Couldn’t load", m.state.value.photosSubtitle)
    }

    @Test fun lateFamilyResultFromThePreviousScopeIsDiscarded() = runTest {
        val deferred = CompletableDeferred<List<FamilyApi.PhotoRef>>()
        val started = CompletableDeferred<Unit>()
        var count = 0
        val m = model(photos = {
            count += 1
            if (count == 1) { started.complete(Unit); deferred.await() } else error("rejected")
        })

        val oldLoad = async { m.load(scope = Any(), modules = FamilyRestModules.NONE) }
        started.await()
        m.load(scope = Any(), modules = FamilyRestModules.NONE)
        deferred.complete(listOf(photo("tenant-a-photo")))
        oldLoad.await()
        yield()

        assertEquals(0, m.state.value.photosCount)
        assertEquals("Couldn’t load", m.state.value.photosSubtitle)
    }

    @Test fun failedRefreshKeepsTheValueAndSaysItMayBeStale() = runTest {
        var lists: suspend () -> List<FamilyApi.ListRef> = { listOf(FamilyApi.ListRef("l1"), FamilyApi.ListRef("l2")) }
        val m = model(lists = { lists() })
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        assertEquals("2 lists", m.state.value.listsSubtitle)
        lists = { error("offline") }

        m.load(scope = "a", modules = FamilyRestModules.ALL)

        assertEquals("May be out of date · 2 lists", m.state.value.listsSubtitle)
        assertFalse(m.state.value.isAuthoritative)
    }

    @Test fun beforeAnyLoadEveryTileSaysLoading() {
        val m = model()
        assertEquals("Loading…", m.state.value.choresSubtitle)
        assertEquals("Loading…", m.state.value.photosSubtitle)
        assertFalse(m.state.value.loaded)
    }

    // ---- tile subtitles (FamilyHubModel.swift's derived lines) ----

    @Test fun tileSubtitlesSummariseEachFeed() = runTest {
        val m = model(
            chores = {
                listOf(
                    FamilyApi.PersonChores(id = "p1", name = "Maya", total = 3, done = 1),
                    FamilyApi.PersonChores(id = "p2", name = "Leo", total = 2, done = 3),
                )
            },
            goals = { listOf(FamilyApi.GoalRef("g1", isFeatured = true), FamilyApi.GoalRef("g2")) },
            stars = {
                listOf(
                    FamilyApi.FamilyStars("Leo", 4),
                    FamilyApi.FamilyStars("Maya", 9),
                    FamilyApi.FamilyStars("Zed", 0),
                    FamilyApi.FamilyStars(null, 2),
                )
            },
            lists = { listOf(FamilyApi.ListRef("l1")) },
            photos = { listOf(photo("1"), photo("2", memory = ""), photo("3", memory = "Beach day")) },
        )
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        val s = m.state.value

        // Over-done people never subtract from the remaining count.
        assertEquals("2 to do today", s.choresSubtitle)
        assertEquals("2 active · 1 featured", s.goalsSubtitle)
        assertEquals("Maya 9 · Leo 4", s.rewardsSubtitle)
        assertEquals("1 list", s.listsSubtitle)
        assertEquals("“Beach day” · 3 new", s.photosSubtitle)
        assertTrue(s.isAuthoritative)
    }

    @Test fun emptyFeedsHaveTheirOwnWords() = runTest {
        val m = model()
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        val s = m.state.value

        assertEquals("All done today 🎉", s.choresSubtitle)
        assertEquals("No goals yet", s.goalsSubtitle)
        assertEquals("No stars yet", s.rewardsSubtitle)
        assertEquals("0 lists", s.listsSubtitle)
        assertEquals("No photos yet", s.photosSubtitle)
    }

    @Test fun photosWithoutAMemoryAreCounted() = runTest {
        val m = model(photos = { listOf(photo("1")) })
        m.load(scope = "a", modules = FamilyRestModules.NONE)
        assertEquals("1 photo", m.state.value.photosSubtitle)
    }

    @Test fun goalsWithoutFeaturedOmitTheSuffix() = runTest {
        val m = model(goals = { listOf(FamilyApi.GoalRef("g1")) })
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        assertEquals("1 active", m.state.value.goalsSubtitle)
    }

    @Test fun anUnnamedStarHolderReadsAsADash() = runTest {
        val m = model(stars = { listOf(FamilyApi.FamilyStars(null, 2)) })
        m.load(scope = "a", modules = FamilyRestModules.ALL)
        assertEquals("— 2", m.state.value.rewardsSubtitle)
    }
}
