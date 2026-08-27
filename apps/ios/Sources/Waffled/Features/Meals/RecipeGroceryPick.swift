import Foundation

/// The opening state and copy for the recipe → "Add to grocery list" picker.
///
/// Pulled out of the sheet so the rule is testable, because getting it wrong is quiet:
/// the sheet used to open with EVERYTHING checked, which meant re-buying whatever the
/// pantry already held. Now the pantry's real matches open unchecked.
///
/// The distinction this file exists to protect:
///
///   `inPantry` — the server matched the ingredient against the household's actual
///                pantry inventory. An **observation**. Pre-uncheck it.
///   `isStaple` — the household is assumed to keep this around. An **assumption**, not
///                an observation. It stays CHECKED and keeps only its muted "likely on
///                hand" hint, because an item missing at the shop costs more than an
///                extra one to uncheck. Reversing that default while implementing the
///                pantry one would silently drop things nobody said they had.
///
/// Mirrors the web's `RecipeGroceryModal`.
enum RecipeGroceryPick {
    /// Whether the "Add to grocery list" action can do anything yet.
    ///
    /// The sheet derives its entire state from `ingredients` at `init`, and the recipe
    /// detail's toolbar menu is live from the first frame — before `loadDetail()` has
    /// returned. Tapping it in that gap opened a sheet with no rows and a dead button.
    /// The action is disabled instead of opening empty: a greyed row says "not yet",
    /// where an empty sheet says "this recipe has no ingredients", which is a lie.
    ///
    /// Deliberately keyed on the ingredients rather than a loading flag — a recipe that
    /// really has none has nothing to add either, and there the same disabled row is the
    /// honest answer rather than a temporary one. Note that a pantry covering the whole
    /// recipe is NOT this case: those rows exist, each says why it opens unchecked, and
    /// "Select all" is there to overrule us.
    static func canAdd(_ ingredients: [WaffledAPI.RecipeIngredientDTO]) -> Bool {
        !ingredients.isEmpty
    }

    /// Which ingredients open checked: everything the pantry did NOT match. `nil`
    /// (a server that never sent the field) means "we don't know", which is not a
    /// reason to leave something off the list — so it stays checked.
    static func initialSelection(_ ingredients: [WaffledAPI.RecipeIngredientDTO]) -> Set<String> {
        Set(ingredients.filter { $0.inPantry != true }.map(\.id))
    }

    /// How many the pantry covered — the number the sheet has to own up to, so nothing
    /// unchecks itself silently.
    static func pantryCount(_ ingredients: [WaffledAPI.RecipeIngredientDTO]) -> Int {
        ingredients.filter { $0.inPantry == true }.count
    }

    /// The line under the title.
    static func intro(pantryCount: Int) -> String {
        guard pantryCount > 0 else { return "Uncheck anything you already have on hand." }
        return "We’ve already unchecked \(pantryCount) item\(pantryCount == 1 ? "" : "s") your pantry says you have."
    }

    /// The commit button. Pre-unchecking can empty the selection outright when the
    /// pantry covers the whole recipe; "Add 0 items" on a dead button explains nothing,
    /// so name the state instead and leave "Select all" as the way out.
    static func addLabel(count: Int) -> String {
        count == 0 ? "Nothing to add" : "Add \(count) item\(count == 1 ? "" : "s")"
    }

    /// The one-line hint under an ingredient's name. There is room for exactly one, and
    /// the real match outranks the assumed one: "in your pantry" is something we
    /// observed, "likely on hand" only something we assumed.
    enum Hint { case inPantry, staple }
    static func hint(for ingredient: WaffledAPI.RecipeIngredientDTO) -> Hint? {
        if ingredient.inPantry == true { return .inPantry }
        return ingredient.isStaple ? .staple : nil
    }
}
