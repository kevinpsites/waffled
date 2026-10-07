package app.waffled.feature.family

import app.waffled.core.model.Capability
import app.waffled.core.model.Person
import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import app.waffled.core.sync.SyncedEvent
import kotlinx.coroutines.test.runTest
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The person spotlight's pure rules, ported from PersonView.swift / WaffledAPI.PersonOverview.
class PersonOverviewTest {

    private fun overview(
        name: String = "Maya Lopez",
        age: Int? = 9,
        memberType: String? = "kid",
        topStreak: Int = 0,
    ) = FamilyApi.PersonOverview(
        person = FamilyApi.PersonOverview.Person(id = "p1", name = name, age = age, memberType = memberType),
        topStreak = topStreak,
        currencies = listOf(
            FamilyApi.PersonOverview.Currency(key = "sticks", label = "Sticks", symbol = "🥢", sortOrder = 1),
            FamilyApi.PersonOverview.Currency(key = "stars", label = "Stars", symbol = "⭐", sortOrder = 0),
        ),
        balances = listOf(
            FamilyApi.PersonOverview.Balance("sticks", 3),
            FamilyApi.PersonOverview.Balance("ghost", 99),
            FamilyApi.PersonOverview.Balance("stars", 12),
        ),
    )

    // ---- header ----

    @Test fun firstNameIsTheFirstWord() {
        assertEquals("Maya", PersonSpotlight.firstName(overview()))
        assertEquals("", PersonSpotlight.firstName(null))
    }

    @Test fun subtitleJoinsAgeAndStreak() {
        assertEquals("Age 9 · 🔥 4-day streak", PersonSpotlight.subtitle(overview(topStreak = 4)))
        assertEquals("Age 9", PersonSpotlight.subtitle(overview()))
    }

    @Test fun subtitleFallsBackToTheMemberType() {
        assertEquals("Kid", PersonSpotlight.subtitle(overview(age = null)))
        assertEquals(" ", PersonSpotlight.subtitle(overview(age = null, memberType = null)))
    }

    @Test fun balancesJoinTheirCurrencyInHouseholdOrderAndDropUnknownOnes() {
        val rows = PersonSpotlight.balances(overview())
        assertEquals(listOf("stars", "sticks"), rows.map { it.key })
        assertEquals(listOf(12, 3), rows.map { it.amount })
        assertEquals("⭐", rows.first().symbol)
    }

    @Test fun symbolFallsBackToAStar() {
        assertEquals("🥢", PersonSpotlight.symbol(overview(), "sticks"))
        assertEquals("⭐", PersonSpotlight.symbol(overview(), "unknown"))
        assertEquals("⭐", PersonSpotlight.symbol(null, "sticks"))
    }

    // ---- who may spend this person's balance ----

    @Test fun youMaySpendYourOwnBalance() {
        val me = Person(id = "p1", name = "Maya")
        assertTrue(PersonSpotlight.maySpend(me, personId = "p1"))
    }

    @Test fun someoneElsesBalanceNeedsRewardManage() {
        val kid = Person(id = "p2", name = "Leo")
        val parent = Person(id = "p3", name = "Ana", capabilities = listOf(Capability.REWARD_MANAGE))
        val admin = Person(id = "p4", name = "Sam", isAdmin = true)
        assertFalse(PersonSpotlight.maySpend(kid, personId = "p1"))
        assertTrue(PersonSpotlight.maySpend(parent, personId = "p1"))
        assertTrue(PersonSpotlight.maySpend(admin, personId = "p1"))
        assertFalse(PersonSpotlight.maySpend(null, personId = "p1"))
    }

    // ---- numbers ----

    @Test fun formatDropsAWholeNumbersDecimal() {
        assertEquals("3", PersonSpotlight.fmt(3.0))
        assertEquals("2.5", PersonSpotlight.fmt(2.5))
        assertEquals("—", PersonSpotlight.fmt(null))
    }

    @Test fun ledgerLabelPrefersTheDetailThenTheSpotAwardNote() {
        fun entry(reason: String, detail: String? = null, note: String? = null) =
            FamilyApi.PersonOverview.LedgerEntry(amount = 1, reason = reason, currency = "stars", detail = detail, note = note)
        assertEquals("Dishes", entry("chore_completed", detail = "Dishes").label)
        assertEquals("chore completed", entry("chore_completed", detail = "").label)
        assertEquals("spot award — so helpful", entry("spot_award", note = " so helpful ").label)
        assertEquals("spot award", entry("spot_award", note = "  ").label)
        // Only a spot award carries its note.
        assertEquals("reward redeemed", entry("reward_redeemed", note = "x").label)
    }

    // ---- chores in the day list (ChoresModel.toggledStatus / needsPhotoToFinish) ----

    private fun chore(status: String, requiresApproval: Boolean = false, requiresPhoto: Boolean = false) =
        FamilyApi.ChoreInstance(
            id = "c", choreId = "t", choreTitle = "Dishes", status = status,
            requiresApproval = requiresApproval, requiresPhoto = requiresPhoto,
        )

    @Test fun togglingAFinishedChoreReopensIt() {
        assertEquals("pending", PersonSpotlight.toggledStatus(chore("done")))
        assertEquals("pending", PersonSpotlight.toggledStatus(chore("awaiting")))
    }

    @Test fun togglingAnOpenChoreFinishesItOrAsksForApproval() {
        assertEquals("done", PersonSpotlight.toggledStatus(chore("pending")))
        assertEquals("awaiting", PersonSpotlight.toggledStatus(chore("pending", requiresApproval = true)))
    }

    @Test fun anOpenPhotoChoreCannotFinishFromATick() {
        assertTrue(PersonSpotlight.needsPhotoToFinish(chore("pending", requiresPhoto = true)))
        assertFalse(PersonSpotlight.needsPhotoToFinish(chore("done", requiresPhoto = true)))
        assertFalse(PersonSpotlight.needsPhotoToFinish(chore("pending")))
    }

    // ---- the person's day ----

    @Test fun theDayListKeepsOnlyThisPersonsEventsForToday() {
        val today = LocalDate.of(2026, 10, 7)
        fun ev(id: String, person: String?) = SyncedEvent(id = id, householdId = "h", title = id, startsAt = null, personId = person)
        val byDay = mapOf(
            today to listOf(ev("mine", "p1"), ev("theirs", "p2"), ev("family", null)),
            today.plusDays(1) to listOf(ev("tomorrow", "p1")),
        )
        assertEquals(listOf("mine"), PersonSpotlight.eventsFor("p1", byDay, today).map { it.id })
        assertTrue(PersonSpotlight.eventsFor("p1", emptyMap(), today).isEmpty())
    }

    @Test fun eventTimeReadsAllDayAClockTimeOrADash() {
        val zone = java.time.ZoneId.of("America/Denver")
        fun ev(start: String?, allDay: Boolean = false) =
            SyncedEvent(id = "e", householdId = "h", title = "t", startsAt = start, allDay = allDay)
        assertEquals("All day", PersonSpotlight.eventTime(ev("2026-10-07T06:00:00Z", allDay = true), zone, java.util.Locale.US))
        assertEquals("3:30 PM", PersonSpotlight.eventTime(ev("2026-10-07T21:30:00Z"), zone, java.util.Locale.US))
        assertEquals("—", PersonSpotlight.eventTime(ev(null), zone, java.util.Locale.US))
    }

    // ---- the model ----

    @Test fun loadKeepsOnlyThisPersonsChores() = runTest {
        val m = PersonOverviewModel(
            personId = "p1",
            fetchOverview = { overview() },
            fetchChores = { date ->
                assertEquals("2026-10-07", date)
                listOf(
                    chore("done").copy(id = "a", personId = "p1"),
                    chore("pending").copy(id = "b", personId = "p2"),
                    chore("pending").copy(id = "c", personId = "p1"),
                )
            },
            today = { "2026-10-07" },
        )
        m.load()
        val s = m.state.value

        assertEquals(listOf("a", "c"), s.chores.map { it.id })
        assertEquals(1, s.choresDone)
        assertFalse(s.loading)
        assertFalse(s.error)
    }

    @Test fun aFailedLoadKeepsThePriorSpotlightAndFlagsTheError() = runTest {
        var fail = false
        val m = PersonOverviewModel(
            personId = "p1",
            fetchOverview = { if (fail) error("offline") else overview() },
            fetchChores = { emptyList() },
            today = { "2026-10-07" },
        )
        m.load()
        fail = true
        m.load()

        assertEquals("Maya Lopez", m.state.value.overview?.person?.name)
        assertTrue(m.state.value.error)
    }

    @Test fun aToggleThatLandsReloadsAndBroadcastsChores() = runTest {
        val bus = RefreshBus()
        val writes = mutableListOf<String>()
        val m = PersonOverviewModel(
            personId = "p1",
            fetchOverview = { overview() },
            fetchChores = { listOf(chore("pending").copy(id = "a", personId = "p1")) },
            today = { "2026-10-07" },
            complete = { writes += "complete:$it" },
            uncomplete = { writes += "uncomplete:$it" },
            refreshBus = bus,
        )
        m.load()

        assertTrue(m.toggleChore("a"))

        assertEquals(listOf("complete:a"), writes)
        assertEquals(1, bus.revisionOf(RefreshDomain.Chores))
    }

    @Test fun aToggleThatFailsRestoresTheStatusAndBroadcastsNothing() = runTest {
        val bus = RefreshBus()
        val m = PersonOverviewModel(
            personId = "p1",
            fetchOverview = { overview() },
            fetchChores = { listOf(chore("done").copy(id = "a", personId = "p1")) },
            today = { "2026-10-07" },
            uncomplete = { error("offline") },
            refreshBus = bus,
        )
        m.load()

        assertFalse(m.toggleChore("a"))

        assertEquals("done", m.state.value.chores.single().status)
        assertEquals(0, bus.revisionOf(RefreshDomain.Chores))
    }

    @Test fun togglingAnUnknownChoreDoesNothing() = runTest {
        val m = PersonOverviewModel(
            personId = "p1",
            fetchOverview = { overview() },
            fetchChores = { emptyList() },
            today = { "2026-10-07" },
        )
        m.load()
        assertFalse(m.toggleChore("missing"))
        assertNull(m.state.value.chores.firstOrNull())
    }
}
