import Foundation
import Testing
@testable import Waffled

// Optimistic drag-and-drop for the weekly meal planner (MealPlanSwap.apply):
// dropping the meal at (srcDate, srcSlot) onto (dstDate, dstSlot) must return the
// post-swap entries *immediately* (the view shows them before the server round-trip):
//   - the source entry moves to the target slot
//   - whatever occupied the target slot moves back to the source slot (a swap)
//   - every other entry is untouched
//   - a drop on itself, or from an empty slot, is a no-op (nil → caller ignores)

private func entry(_ date: String, _ slot: String, title: String,
                   recipeId: String? = nil, cookName: String? = nil) -> WaffledAPI.WeekEntryDTO {
    WaffledAPI.WeekEntryDTO(
        id: "id-\(date)-\(slot)",
        date: date,
        mealType: slot,
        title: recipeId == nil ? title : nil,
        recipeId: recipeId,
        recipe: recipeId == nil ? nil : .init(title: title, emoji: "🍜", category: "dinner",
                                              prepTimeMinutes: 10, cookTimeMinutes: 25,
                                              servings: 4, imageUrl: nil),
        cook: cookName.map { .init(personId: "p-\($0)", name: $0, avatarEmoji: nil, colorHex: nil) })
}

private func at(_ entries: [WaffledAPI.WeekEntryDTO], _ date: String, _ slot: String)
    -> WaffledAPI.WeekEntryDTO? {
    entries.first { $0.date == date && $0.mealType == slot }
}

@Suite("MealPlanSwap.apply — optimistic week-planner drop")
struct MealPlanSwapTests {

    @Test("moving onto an empty slot relocates the entry and empties the source")
    func moveToEmptySlot() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-14", "lunch", title: "Leftovers")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-15", dstSlot: "dinner")
        let moved = try! #require(out.flatMap { at($0, "2026-07-15", "dinner") })
        #expect(moved.displayTitle == "Tacos")
        #expect(out.flatMap { at($0, "2026-07-13", "dinner") } == nil)
        // The unrelated lunch is untouched.
        #expect(out.flatMap { at($0, "2026-07-14", "lunch") }?.displayTitle == "Leftovers")
        #expect(out?.count == 2)
    }

    @Test("dropping onto an occupied slot swaps the two entries")
    func swapOccupiedSlots() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-16", "dinner", title: "Curry", recipeId: "r2")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-16", dstSlot: "dinner")
        #expect(out.flatMap { at($0, "2026-07-16", "dinner") }?.displayTitle == "Tacos")
        #expect(out.flatMap { at($0, "2026-07-13", "dinner") }?.displayTitle == "Curry")
        #expect(out?.count == 2)
    }

    @Test("the iPad grid can swap across meal types — mealType moves with the slot")
    func crossMealTypeSwap() {
        let week = [entry("2026-07-13", "breakfast", title: "Pancakes", recipeId: "r1"),
                    entry("2026-07-13", "dinner", title: "Curry", recipeId: "r2")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "breakfast",
                                     dstDate: "2026-07-13", dstSlot: "dinner")
        let movedDown = out.flatMap { at($0, "2026-07-13", "dinner") }
        let movedUp = out.flatMap { at($0, "2026-07-13", "breakfast") }
        #expect(movedDown?.displayTitle == "Pancakes")
        #expect(movedDown?.mealType == "dinner")
        #expect(movedUp?.displayTitle == "Curry")
        #expect(movedUp?.mealType == "breakfast")
    }

    @Test("a drop on the slot it came from is a no-op")
    func dropOnSelf() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        #expect(MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                   dstDate: "2026-07-13", dstSlot: "dinner") == nil)
    }

    @Test("dragging from an empty slot is a no-op")
    func emptySource() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        #expect(MealPlanSwap.apply(week, srcDate: "2026-07-14", srcSlot: "dinner",
                                   dstDate: "2026-07-15", dstSlot: "dinner") == nil)
    }

    @Test("the moved copy keeps its recipe, free-text title, and cook")
    func preservesFields() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1", cookName: "Jerry"),
                    entry("2026-07-14", "dinner", title: "Grandma's soup")]
        let out = MealPlanSwap.apply(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                     dstDate: "2026-07-14", dstSlot: "dinner")
        let moved = out.flatMap { at($0, "2026-07-14", "dinner") }
        #expect(moved?.recipeId == "r1")
        #expect(moved?.recipe?.emoji == "🍜")
        #expect(moved?.cook?.name == "Jerry")
        // The free-text meal that swapped back keeps its title (no recipe).
        let back = out.flatMap { at($0, "2026-07-13", "dinner") }
        #expect(back?.recipeId == nil)
        #expect(back?.title == "Grandma's soup")
    }
}

// A minimal server: slot → planned entry. Applying an Op mirrors what
// setMealPlan/clearMealPlan do to the real rows.
private struct FakeMealServer {
    var slots: [String: WaffledAPI.WeekEntryDTO] = [:]
    init(_ entries: [WaffledAPI.WeekEntryDTO]) {
        for e in entries { slots["\(e.date)|\(e.mealType)"] = e }
    }
    mutating func apply(_ op: MealPlanSwap.Op) { slots["\(op.date)|\(op.mealType)"] = op.entry }
    func meal(_ date: String, _ slot: String) -> WaffledAPI.WeekEntryDTO? { slots["\(date)|\(slot)"] }
    /// Every distinct meal currently planned anywhere (by display title).
    var titles: Set<String> { Set(slots.values.map(\.displayTitle)) }
}

@Suite("MealPlanSwap.writes — loss-safe server write order")
struct MealPlanSwapWritesTests {

    @Test("the dragged meal lands in the target slot first; the source slot is rewritten second")
    func draggedMealWritesFirst() throws {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-16", "dinner", title: "Curry", recipeId: "r2")]
        let plan = try #require(MealPlanSwap.writes(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                                    dstDate: "2026-07-16", dstSlot: "dinner"))
        #expect(plan.ordered.count == 2)
        // Write 0: upsert the dragged meal into the target — its own row untouched.
        #expect(plan.ordered[0].date == "2026-07-16" && plan.ordered[0].mealType == "dinner")
        #expect(plan.ordered[0].entry?.displayTitle == "Tacos")
        // Write 1: only now rewrite the source slot with the displaced meal.
        #expect(plan.ordered[1].date == "2026-07-13" && plan.ordered[1].mealType == "dinner")
        #expect(plan.ordered[1].entry?.displayTitle == "Curry")
    }

    @Test("a failure between the writes never loses a meal from the server (swap case)")
    func failureBetweenWritesKeepsBothMeals() throws {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1"),
                    entry("2026-07-16", "dinner", title: "Curry", recipeId: "r2")]
        let plan = try #require(MealPlanSwap.writes(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                                    dstDate: "2026-07-16", dstSlot: "dinner"))
        var server = FakeMealServer(week)
        server.apply(plan.ordered[0])   // write 1 lands…
        // …and the connection drops before write 2. The dragged meal must still exist
        // (worst case duplicated) — the old order left it in zero slots.
        #expect(server.titles.contains("Tacos"))
        #expect(server.meal("2026-07-13", "dinner")?.displayTitle == "Tacos")
        // The compensating write restores the target slot, returning the server to
        // its exact pre-drag state.
        server.apply(plan.compensation)
        #expect(server.meal("2026-07-13", "dinner")?.displayTitle == "Tacos")
        #expect(server.meal("2026-07-16", "dinner")?.displayTitle == "Curry")
    }

    @Test("a failure between the writes on a move-to-empty degrades to a recoverable duplicate")
    func moveToEmptyFailureDuplicatesNotLoses() throws {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        let plan = try #require(MealPlanSwap.writes(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                                    dstDate: "2026-07-15", dstSlot: "dinner"))
        var server = FakeMealServer(week)
        server.apply(plan.ordered[0])
        // Write 2 fails: the meal is planned twice — recoverable — never zero times.
        #expect(server.meal("2026-07-13", "dinner")?.displayTitle == "Tacos")
        #expect(server.meal("2026-07-15", "dinner")?.displayTitle == "Tacos")
        // Compensation clears the duplicate (the target was empty pre-drag).
        server.apply(plan.compensation)
        #expect(server.meal("2026-07-15", "dinner") == nil)
        #expect(server.meal("2026-07-13", "dinner")?.displayTitle == "Tacos")
    }

    @Test("no-op drops produce no write plan")
    func noOpDropsHaveNoWrites() {
        let week = [entry("2026-07-13", "dinner", title: "Tacos", recipeId: "r1")]
        #expect(MealPlanSwap.writes(week, srcDate: "2026-07-13", srcSlot: "dinner",
                                    dstDate: "2026-07-13", dstSlot: "dinner") == nil)
        #expect(MealPlanSwap.writes(week, srcDate: "2026-07-14", srcSlot: "dinner",
                                    dstDate: "2026-07-15", dstSlot: "dinner") == nil)
    }
}

@Suite("MealPlanSwap.Gate — one in-flight discipline for every reload path")
struct MealPlanSwapGateTests {

    @Test("reloads run immediately when nothing is in flight")
    func idleReloadsRun() {
        var g = MealPlanSwap.Gate()
        let now = g.shouldReloadNow()
        #expect(now)
    }

    @Test("every reload trigger is deferred while a swap is in flight, then replayed once on settle")
    func reloadSuppressedUntilSettle() {
        var g = MealPlanSwap.Gate()
        g.begin()
        // mealsRev bump, week paging, pull-to-refresh — all deferred mid-flight.
        let rev = g.shouldReloadNow(), page = g.shouldReloadNow(), pull = g.shouldReloadNow()
        #expect(!rev && !page && !pull)
        // The settle replays exactly one reload, after reconcile/rollback finished.
        let replay = g.finish()
        #expect(replay)
        let idleAgain = g.shouldReloadNow()
        #expect(idleAgain)
    }

    @Test("a lone failed swap may roll its snapshot back itself (no reload was deferred)")
    func soleSwapMayRollBack() {
        var g = MealPlanSwap.Gate()
        g.begin()
        #expect(g.mayApplyResult)
        let replay = g.finish()
        #expect(!replay)   // nothing deferred → nothing to replay
    }

    @Test("overlapping swaps never write entries themselves — the settle reload owns them")
    func overlappingSwapsDeferToSettle() {
        var g = MealPlanSwap.Gate()
        g.begin()   // swap A
        g.begin()   // swap B overlaps
        // A finishes first: another optimistic swap is still displayed — writing A's
        // reconcile/rollback would clobber it.
        #expect(!g.mayApplyResult)
        g.requestSettleReload()
        let replayAfterA = g.finish()
        #expect(!replayAfterA)        // B still in flight → no replay yet
        // B is sole now, but a reload is queued behind it — server truth wins.
        #expect(!g.mayApplyResult)
        let replayAfterB = g.finish()
        #expect(replayAfterB)         // last swap out replays exactly one reload
    }

    @Test("a deferred reload poisons self-apply even for a sole swap")
    func deferredReloadPoisonsSelfApply() {
        var g = MealPlanSwap.Gate()
        g.begin()
        _ = g.shouldReloadNow()       // e.g. our own first write bumped mealsRev
        #expect(!g.mayApplyResult)    // half-committed state exists → fetch truth
        let replay = g.finish()
        #expect(replay)
    }
}
