import Foundation
import Testing
@testable import Waffled

// The Meal Builder composes a **plate** — a named, multi-recipe meal ("BBQ Sunday" =
// BBQ Chicken (main) + Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert)).
//
// Everything the builder screen derives lives in `PlateRoles`, `OnHandClaim` and
// `MealBuilderModel` so it can be tested without a server or a view body. The cases
// below pin the three rules that make a builder *look* finished while being broken:
// an empty role group that disappears (leaving no way to add a main), a ＋ that
// forgets which role it belongs to, and a pantry-off plate that invents an on-hand
// claim it cannot make.

// MARK: fixtures

func plateDish(_ recipeId: String, _ title: String?, role: String, sortOrder: Int = 0,
               prep: Int? = nil, cookMinutes: Int? = nil, cookName: String? = nil,
               onHand: WaffledAPI.OnHandCount? = nil, toBuy: Int = 0,
               toBuyNames: [String] = []) -> WaffledAPI.MealDishDTO {
    WaffledAPI.MealDishDTO(
        recipeId: recipeId, title: title, emoji: nil, category: nil, role: role,
        sortOrder: sortOrder, prepTimeMinutes: prep, cookTimeMinutes: cookMinutes, servings: nil,
        imageUrl: nil,
        cook: cookName.map { WaffledAPI.MealCookDTO(personId: "person-\($0)", name: $0,
                                                    avatarEmoji: nil, colorHex: nil) },
        onHand: onHand, toBuy: toBuy, toBuyNames: toBuyNames)
}

func plateFixture(_ id: String = "plate-1", name: String = "BBQ Sunday", servings: Int = 4,
                  isSaved: Bool = false, totalMinutes: Int? = nil,
                  onHand: WaffledAPI.OnHandCount? = nil, toBuy: Int = 0,
                  toBuyNames: [String] = [],
                  dishes: [WaffledAPI.MealDishDTO] = []) -> WaffledAPI.MealDTO {
    WaffledAPI.MealDTO(
        id: id, name: name, servings: servings, isSaved: isSaved, createdBy: nil,
        createdAt: "2026-08-11T18:35:41.000Z", recipeCount: dishes.count,
        emojis: [], totalMinutes: totalMinutes, onHand: onHand, toBuy: toBuy,
        toBuyNames: toBuyNames, recipes: dishes)
}

// MARK: role grouping

@Suite struct PlateRoleGroupingTests {
    /// Three scaffold groups in plate order — Main, Sides, Dessert.
    @Test func scaffoldsThreeRolesInPlateOrder() {
        #expect(PlateRoles.ordered.map(\.key) == ["main", "side", "dessert"])
        #expect(PlateRoles.ordered.map(\.label) == ["Main", "Sides", "Dessert"])
    }

    @Test func groupsDishesByRoleAndSortsByPlateOrder() {
        let dishes = [
            plateDish("d", "Peach Cobbler", role: "dessert", sortOrder: 3),
            plateDish("c", "Coleslaw", role: "side", sortOrder: 2),
            plateDish("a", "BBQ Chicken", role: "main", sortOrder: 0),
            plateDish("b", "Potato Salad", role: "side", sortOrder: 1),
        ]
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.main).map(\.recipeId) == ["a"])
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.side).map(\.recipeId) == ["b", "c"])
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.dessert).map(\.recipeId) == ["d"])
    }

    /// `role` is free text, not an enum (decision 3), so a role the builder doesn't
    /// scaffold ('bread') must still land somewhere. Sides is the catch-all — the
    /// alternative is a dish that is on the plate but rendered nowhere.
    @Test func anUnknownRoleFallsIntoSides() {
        let dishes = [plateDish("x", "Garlic Bread", role: "bread", sortOrder: 0)]
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.side).map(\.recipeId) == ["x"])
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.main).isEmpty)
        #expect(PlateRoles.dishes(dishes, in: PlateRoles.dessert).isEmpty)
    }

    /// An empty group still renders — its "＋ Add a main" slot is the ONLY way to add
    /// a main, so hiding empty sections (the mobile instinct) removes the affordance.
    @Test func everyRoleGroupIsShownEvenWhenEmpty() {
        let groups = PlateRoles.groups(of: [plateDish("a", "BBQ Chicken", role: "main")])
        #expect(groups.count == 3)
        #expect(groups.map(\.role.key) == ["main", "side", "dessert"])
        #expect(groups[1].dishes.isEmpty)
        #expect(groups[1].role.addLabel == "Add a side")
    }
}

// MARK: the pantry-off render decision

@Suite struct OnHandClaimTests {
    /// Pantry ON, nothing left to buy → the one case that may claim "all on hand".
    @Test func pantryOnAndNothingToBuyClaimsAllOnHand() {
        #expect(OnHandClaim.of(onHand: .init(have: 5, total: 5), toBuy: 0) == .allOnHand)
    }

    /// Pantry OFF and nothing to buy → say NOTHING. `onHand == nil` means "we can't
    /// say", so neither "✓ all on hand" nor a "0 of N" badge is honest here. This is
    /// the branch that gets missed.
    @Test func pantryOffAndNothingToBuySaysNothing() {
        #expect(OnHandClaim.of(onHand: nil, toBuy: 0) == .nothingToSay)
    }

    /// "N to buy" is not pantry-derived, so it works either way.
    @Test func toBuyWorksWithOrWithoutThePantry() {
        #expect(OnHandClaim.of(onHand: nil, toBuy: 6) == .toBuy(6))
        #expect(OnHandClaim.of(onHand: .init(have: 3, total: 5), toBuy: 2) == .toBuy(2))
    }
}

// MARK: footer stats

@Suite struct PlateStatsTests {
    @Test func formatsHandsOnTime() {
        #expect(MealBuilderModel.hoursMinutes(nil) == "—")
        #expect(MealBuilderModel.hoursMinutes(0) == "—")
        #expect(MealBuilderModel.hoursMinutes(45) == "45m")
        #expect(MealBuilderModel.hoursMinutes(60) == "1h")
        #expect(MealBuilderModel.hoursMinutes(75) == "1h 15m")
    }
}

// MARK: the model

/// A stand-in plate server. Records every write so a test can assert what the ＋
/// actually sent, and counts creates so the lazy-create-once guard is observable.
private final class FakePlateServer: @unchecked Sendable {
    var creates = 0
    var createdNames: [String] = []
    var added: [(mealId: String, recipeId: String, role: String?)] = []
    var flattened: [String] = []
    var patched: [(recipeId: String, role: String?, cook: WaffledAPI.CookAssignment)] = []
    var removed: [String] = []
    var updates: [(name: String?, servings: Int?, isSaved: Bool?)] = []
    var addedToList = 0
    var scheduled: [(date: String, mealType: String)] = []
    /// Fail every write (the offline/rollback path).
    var failing = false
    /// Held open so a test can drive two writes that are genuinely in flight at once.
    var gate: (@Sendable () async -> Void)?

    private(set) var meal = plateFixture(dishes: [])

    func api() -> MealBuilderAPI {
        MealBuilderAPI(
            fetch: { [self] _ in meal },
            create: { [self] name, servings in
                await gate?()
                if failing { throw FakeError.offline }
                creates += 1
                createdNames.append(name)
                meal = plateFixture(name: name, servings: servings)
                return meal
            },
            update: { [self] _, name, servings, isSaved in
                if failing { throw FakeError.offline }
                updates.append((name, servings, isSaved))
                meal = plateFixture(meal.id, name: name ?? meal.name,
                                    servings: servings ?? meal.servings,
                                    isSaved: isSaved ?? meal.isSaved, dishes: meal.recipes)
                return meal
            },
            addDish: { [self] mealId, recipeId, role in
                if failing { throw FakeError.offline }
                added.append((mealId, recipeId, role))
                meal = plateFixture(meal.id, name: meal.name, servings: meal.servings,
                                    isSaved: meal.isSaved,
                                    dishes: meal.recipes + [plateDish(recipeId, recipeId,
                                                                      role: role ?? "side",
                                                                      sortOrder: meal.recipes.count)])
                return meal
            },
            flatten: { [self] _, savedMealId in
                if failing { throw FakeError.offline }
                flattened.append(savedMealId)
                return meal
            },
            patchDish: { [self] _, recipeId, role, cook in
                if failing { throw FakeError.offline }
                patched.append((recipeId, role, cook))
                return meal
            },
            removeDish: { [self] _, recipeId in
                if failing { throw FakeError.offline }
                removed.append(recipeId)
                meal = plateFixture(meal.id, name: meal.name, servings: meal.servings,
                                    isSaved: meal.isSaved,
                                    dishes: meal.recipes.filter { $0.recipeId != recipeId })
                return meal
            },
            addToList: { [self] _ in
                if failing { throw FakeError.offline }
                addedToList += 1
                return 4
            },
            schedule: { [self] _, date, mealType, _ in
                if failing { throw FakeError.offline }
                scheduled.append((date, mealType))
            })
    }

    enum FakeError: Error { case offline }
}

@MainActor
@Suite struct MealBuilderModelTests {
    /// The plate is created lazily: opening the builder must not POST an empty meal.
    @Test func opensWithoutCreatingAPlate() {
        let server = FakePlateServer()
        _ = MealBuilderModel(api: server.api())
        #expect(server.creates == 0)
    }

    /// One create, ever. A fast rename-then-add fires two writes that both need an
    /// id; the create must be shared, not raced.
    @Test func renameThenAddCreatesThePlateOnlyOnce() async {
        let server = FakePlateServer()
        // Hold the create open so both writes are genuinely in flight together.
        let opened = Gate()
        server.gate = { await opened.wait() }
        let m = MealBuilderModel(api: server.api())
        m.name = "BBQ Sunday"

        async let rename: Void = m.commitRename()
        async let add: Void = m.addRecipe("chicken", role: PlateRoles.main)
        await opened.open()
        _ = await (rename, add)

        #expect(server.creates == 1)
        #expect(server.createdNames == ["BBQ Sunday"])
        #expect(server.added.count == 1)
    }

    /// Naming nothing still gives the plate a name — the placeholder invites a name
    /// rather than making you clear "New meal" first.
    @Test func anUnnamedPlateIsCreatedWithTheDefaultName() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        #expect(server.createdNames == [MealBuilderModel.newName])
    }

    /// The ＋ carries the role of the group it sits in. Filing everything under Sides
    /// is exactly the defect the web shipped ("I can't drag it to Main" was really
    /// "＋ ignores where I am"), and an explicit role also avoids the bare re-add that
    /// wipes a dish's role, cook and position.
    @Test func addingFromARoleSlotFilesTheDishUnderThatRole() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        await m.addRecipe("cobbler", role: PlateRoles.dessert)
        #expect(server.added.map(\.role) == ["main", "dessert"])
        #expect(m.meal?.recipes.map(\.role) == ["main", "dessert"])
    }

    /// A saved plate added to the plate under construction FLATTENS (decision 12) —
    /// it is a different call from adding a recipe, and meals never nest.
    @Test func addingASavedPlateFlattensIt() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addSavedMeal("saved-plate")
        #expect(server.flattened == ["saved-plate"])
        #expect(server.added.isEmpty)
    }

    /// "Nobody" must clear the cook explicitly — the server distinguishes an absent
    /// cook (leave it alone) from an explicit null, so `.unchanged` would silently
    /// make un-assigning impossible.
    @Test func pickingNobodyClearsTheCook() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        await m.assignCook("chicken", personId: "kevin")
        await m.assignCook("chicken", personId: nil)
        #expect(server.patched.map(\.cook) == [.person("kevin"), .clear])
    }

    /// Tapping the stepper is not a reason to create a plate — the new servings ride
    /// along on the lazy create instead.
    @Test func steppingServingsOnAFreshPlateDoesNotCreateIt() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.changeServings(6)
        #expect(server.creates == 0)
        #expect(m.servings == 6)
        await m.addRecipe("chicken", role: PlateRoles.main)
        #expect(m.meal?.servings == 6)
    }

    /// A failed write rolls the optimistic paint back and says so — a rename or a
    /// library toggle that stayed on screen after the server rejected it is how the
    /// web's silent-failure bug happened.
    @Test func aFailedToggleRollsBackAndReportsIt() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        server.failing = true
        await m.toggleSaved()
        #expect(!m.isSaved)
        #expect(m.message != nil)
    }

    /// Two writes in flight, each answering with the whole plate: the older reply must
    /// not repaint over the newer one (it would resurrect a removed dish, and it does
    /// not self-heal).
    @Test func aStaleReplyDoesNotRepaintOverANewerOne() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        let stale = plateFixture("plate-1", name: "stale", dishes: [])
        m.applyIfCurrent(stale, seq: 0)
        #expect(m.meal?.name != "stale")
    }

    /// Adding the plate to the grocery list reports how many rows it actually added.
    @Test func addingToTheListReportsWhatItAdded() async {
        let server = FakePlateServer()
        let m = MealBuilderModel(api: server.api())
        await m.addRecipe("chicken", role: PlateRoles.main)
        await m.addToGrocery()
        #expect(server.addedToList == 1)
        #expect(m.message?.contains("4") == true)
    }
}

/// A one-shot async gate, so a test can hold a "server call" open while it starts a
/// second one. Plain `Task.sleep` would make the lazy-create test a timing test.
private actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for w in waiters { w.resume() }
        waiters = []
    }
}
