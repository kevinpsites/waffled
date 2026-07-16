import Foundation
import Testing
@testable import Waffled

// Unit tests for the Today dashboard's REST-backed model — the loading-state
// contract the cards rely on: "loading" must be distinguishable from "loaded and
// empty" (no flash of the empty state before data arrives), and a failed refresh
// must keep the prior values instead of blanking the cards.

// MARK: stub plumbing

/// Mutable fetch results the stubbed closures read — lets a test flip a domain
/// between "succeeds with N rows" and "fails" (nil) across successive loads.
private final class StubFeed: @unchecked Sendable {
    var meals: [WaffledAPI.WeekEntryDTO]? = []
    var chores: [WaffledAPI.PersonChoresDTO]? = []
    var grocery: [WaffledAPI.GroceryItemDTO]? = []
    var goals: [WaffledAPI.Goal]? = []
    var recap: [WaffledAPI.GoalRecapItem]? = []
    var suggestions: [WaffledAPI.GoalSuggestionItem]? = []
}

@MainActor
private func model(_ feed: StubFeed) -> DashboardModel {
    DashboardModel(
        fetchMeals: { _ in feed.meals },
        fetchChores: { feed.chores },
        fetchGrocery: { feed.grocery },
        fetchGoals: { feed.goals },
        fetchRecap: { feed.recap },
        fetchSuggestions: { feed.suggestions })
}

private func dinner(_ date: String, title: String? = "Tacos") -> WaffledAPI.WeekEntryDTO {
    WaffledAPI.WeekEntryDTO(id: UUID().uuidString, date: date, mealType: "dinner",
                            title: title, recipeId: nil, recipe: nil, cook: nil)
}

private func person(_ name: String, total: Int, done: Int = 0) -> WaffledAPI.PersonChoresDTO {
    WaffledAPI.PersonChoresDTO(id: UUID().uuidString, name: name, avatarEmoji: nil,
                               colorHex: nil, total: total, done: done, stars: done)
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

// MARK: tests

@MainActor
@Suite struct DashboardModelLoadingStateTests {
    /// The bug: cards must be able to tell "still loading" apart from "loaded and
    /// empty". A fresh model reports neither domain loaded.
    @Test func startsUnloaded() {
        let m = model(StubFeed())
        #expect(!m.loaded)
        #expect(!m.goalsLoaded)
    }

    /// Goals finishing with zero rows is "loaded and empty" — only then may the
    /// card show its empty state.
    @Test func emptyGoalsAreLoadedNotLoading() async {
        let m = model(StubFeed())
        await m.loadGoals()
        #expect(m.goalsLoaded)
        #expect(m.goals.isEmpty)
    }

    /// The dash `loaded` flag must not stand in for the goals fetch: after only
    /// `load()` (meals/chores/grocery), goals still count as loading.
    @Test func dashLoadDoesNotMarkGoalsLoaded() async {
        let m = model(StubFeed())
        await m.load(todayKey: today)
        #expect(m.loaded)
        #expect(!m.goalsLoaded)
    }

    @Test func loadGoalsStoresRows() async {
        let feed = StubFeed()
        feed.goals = [goal("Read 10 books")]
        let m = model(feed)
        await m.loadGoals()
        #expect(m.goals.map(\.title) == ["Read 10 books"])
        #expect(m.goalsLoaded)
    }
}

@MainActor
@Suite struct DashboardModelRefreshTests {
    /// Tonight's dinner comes from today's dinner slot; other days/slots don't count.
    @Test func picksTonightsDinner() async {
        let feed = StubFeed()
        feed.meals = [dinner("2026-07-15"), dinner(today, title: "Waffles")]
        let m = model(feed)
        await m.load(todayKey: today)
        #expect(m.tonight?.title == "Waffles")
        #expect(m.loaded)
    }

    /// A successful refresh with no dinner clears the card — the plan changed
    /// elsewhere and today's meal was removed.
    @Test func successfulRefreshClearsRemovedDinner() async {
        let feed = StubFeed()
        feed.meals = [dinner(today)]
        let m = model(feed)
        await m.load(todayKey: today)
        #expect(m.tonight != nil)
        feed.meals = []
        await m.load(todayKey: today)
        #expect(m.tonight == nil)
    }

    /// A failed refresh (offline, expired token) keeps the prior values instead of
    /// blanking the cards to their empty states.
    @Test func failedRefreshKeepsPriorValues() async {
        let feed = StubFeed()
        feed.meals = [dinner(today, title: "Curry")]
        feed.chores = [person("June", total: 3, done: 1)]
        feed.grocery = [.init(id: "a", checked: false), .init(id: "b", checked: true)]
        feed.goals = [goal("Bike 100 mi")]
        let m = model(feed)
        await m.load(todayKey: today)
        await m.loadGoals()
        feed.meals = nil; feed.chores = nil; feed.grocery = nil; feed.goals = nil
        await m.load(todayKey: today)
        await m.loadGoals()
        #expect(m.tonight?.title == "Curry")
        #expect(m.chores.count == 1)
        #expect(m.groceryRemaining == 1)
        #expect(m.goals.count == 1)
    }

    /// People with no chores today are dropped; grocery counts only unchecked items.
    @Test func filtersChoresAndCountsGrocery() async {
        let feed = StubFeed()
        feed.chores = [person("June", total: 2), person("Rex", total: 0)]
        feed.grocery = [.init(id: "a", checked: false), .init(id: "b", checked: false),
                        .init(id: "c", checked: true)]
        let m = model(feed)
        await m.load(todayKey: today)
        #expect(m.chores.map(\.name) == ["June"])
        #expect(m.groceryRemaining == 2)
    }
}
