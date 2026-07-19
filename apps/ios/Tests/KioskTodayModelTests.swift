import Foundation
import Testing
@testable import Waffled

// The iPad kiosk's Today model must honor the same loading-state contract as the
// phone's DashboardModel (they share RestDomain): a failed fetch keeps the prior
// values instead of blanking the always-on display to false empty states
// ("All bought ✓", "No dinner planned"), each domain tracks its own loaded flag,
// and a successful-but-empty fetch genuinely clears.

// MARK: shared RestDomain contract

@MainActor
@Suite struct RestDomainTests {
    @Test func startsUnloaded() {
        let d = RestDomain<[Int]>([])
        #expect(!d.loaded)
        #expect(d.value.isEmpty)
    }

    /// nil = the fetch failed: keep the prior value, but still count as loaded so
    /// the card doesn't sit on "Loading…" forever.
    @Test func failureKeepsPriorValueButMarksLoaded() {
        let d = RestDomain<[Int]>([])
        d.apply([1, 2])
        d.apply(nil)
        #expect(d.value == [1, 2])
        #expect(d.loaded)
    }

    /// A successful fetch applies even when empty — that's real data ("the dinner
    /// was removed"), not an error.
    @Test func emptySuccessApplies() {
        let d = RestDomain<[Int]>([7])
        d.apply([])
        #expect(d.value.isEmpty)
        #expect(d.loaded)
    }
}

// MARK: kiosk model

private final class KioskFeed: @unchecked Sendable {
    var chores: [WaffledAPI.PersonChoresDTO]? = []
    var meals: [WaffledAPI.WeekEntryDTO]? = []
    var grocery: [WaffledAPI.ListItemDTO]? = []
    var goals: [WaffledAPI.Goal]? = []
}

@MainActor
private func model(_ feed: KioskFeed) -> KioskTodayModel {
    KioskTodayModel(
        fetchChores: { feed.chores },
        fetchMeals: { _ in feed.meals },
        fetchGrocery: { feed.grocery },
        fetchGoals: { feed.goals },
        fetchWeather: { nil })
}

private func dinner(_ date: String, title: String? = "Tacos") -> WaffledAPI.WeekEntryDTO {
    WaffledAPI.WeekEntryDTO(id: UUID().uuidString, date: date, mealType: "dinner",
                            title: title, recipeId: nil, recipe: nil, cook: nil)
}

private func person(_ name: String, total: Int) -> WaffledAPI.PersonChoresDTO {
    WaffledAPI.PersonChoresDTO(id: UUID().uuidString, name: name, avatarEmoji: nil,
                               colorHex: nil, total: total, done: 0, stars: 0)
}

private func item(_ name: String, checked: Bool = false) -> WaffledAPI.ListItemDTO {
    WaffledAPI.ListItemDTO(id: UUID().uuidString, name: name, quantity: nil,
                           checked: checked, section: nil, assignee: nil,
                           aisle: nil, sourceRecipeIds: nil)
}

private func goal(_ title: String) -> WaffledAPI.Goal {
    WaffledAPI.Goal(id: UUID().uuidString, goalListId: nil, title: title, emoji: nil,
                    category: nil, goalType: "total", unit: nil, habitPeriod: nil,
                    habitTargetPerPeriod: nil, trackingMode: "shared", participantMode: nil,
                    targetBasis: nil, deadline: nil, isFeatured: false, isSpotlight: nil,
                    target: 10, totalProgress: 2, milestoneTotal: 0, milestoneReached: 0,
                    streakDays: 0, autoFromCalendar: false, healthMetric: nil,
                    createdAt: nil, participants: [])
}

private let today = "2026-07-16"

@MainActor
@Suite struct KioskTodayModelTests {
    @Test func startsUnloaded() {
        let m = model(KioskFeed())
        #expect(!m.choresLoaded)
        #expect(!m.mealsLoaded)
        #expect(!m.groceryLoaded)
        #expect(!m.goalsLoaded)
    }

    /// The original flash: chores (one fast call) finishing must not mark the
    /// slower domains loaded.
    @Test func loadChoresDoesNotMarkOtherDomainsLoaded() async {
        let m = model(KioskFeed())
        await m.loadChores()
        #expect(m.choresLoaded)
        #expect(!m.mealsLoaded)
        #expect(!m.groceryLoaded)
        #expect(!m.goalsLoaded)
    }

    /// A network blip / expired token on the always-on iPad must not blank the
    /// dashboard to "All bought ✓" / "No dinner planned" / "No goals yet".
    @Test func failedRefreshKeepsPriorValues() async {
        let feed = KioskFeed()
        feed.meals = [dinner(today, title: "Curry"), dinner("2026-07-17")]
        feed.chores = [person("June", total: 3)]
        feed.grocery = [item("Milk"), item("Eggs", checked: true)]
        feed.goals = [goal("Bike 100 mi")]
        let m = model(feed)
        await m.load(todayKey: today)
        #expect(m.tonight?.title == "Curry")
        #expect(m.weekDinners.count == 2)

        feed.meals = nil; feed.chores = nil; feed.grocery = nil; feed.goals = nil
        await m.load(todayKey: today)
        #expect(m.tonight?.title == "Curry")
        #expect(m.weekDinners.count == 2)
        #expect(m.chores.map(\.name) == ["June"])
        #expect(m.grocery.count == 2)
        #expect(m.goals.map(\.title) == ["Bike 100 mi"])
    }

    /// An empty success is real data: the plan changed and tonight's dinner is gone.
    @Test func emptyMealsSuccessClearsTonight() async {
        let feed = KioskFeed()
        feed.meals = [dinner(today)]
        let m = model(feed)
        await m.loadMeals(todayKey: today)
        #expect(m.tonight != nil)
        feed.meals = []
        await m.loadMeals(todayKey: today)
        #expect(m.tonight == nil)
        #expect(m.weekDinners.isEmpty)
        #expect(m.mealsLoaded)
    }

    /// Chores keep their existing filter: people with nothing assigned drop out.
    @Test func choresFilterPeopleWithNoneToday() async {
        let feed = KioskFeed()
        feed.chores = [person("June", total: 2), person("Rex", total: 0)]
        let m = model(feed)
        await m.loadChores()
        #expect(m.chores.map(\.name) == ["June"])
    }
}
