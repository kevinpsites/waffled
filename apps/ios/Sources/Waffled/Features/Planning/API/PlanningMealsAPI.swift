import Foundation

// Weekly Planning · step 7 "Meals" — this step's wire types, its ONE read and its three writes.
// Ported from `apps/web/src/lib/api/planning/meals.ts`.
//
// THE STEP OWNS NO DATA. Its three own routes are the ones that cannot be composed from the Meals
// screen's endpoints, because only the fill can refuse a night somebody already decided AND hand
// back a receipt. Every date/time is a `String`: they are household-local calendar labels that
// must never round-trip through a device `Date`.
extension WaffledAPI {

    /// One calendar event on a night — the CONTEXT above the dish. The dot is painted from
    /// `personColor` exactly as the web step does; the family-aware `EventPalette` rule is
    /// deliberately NOT applied, or the two platforms would disagree about the same night.
    struct PlanningNightEvent: Decodable, Identifiable, Sendable, Equatable {
        let id: String
        let title: String
        let startsAt: String
        let allDay: Bool
        let personId: String?
        let personName: String?
        let personColor: String?
        let participantIds: [String]

        /// `?? []` / `?? false` on purpose: a payload missing one field must cost that field, not
        /// the whole week — Swift throws on a missing non-optional array where the web shrugs.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            startsAt = try c.decodeIfPresent(String.self, forKey: .startsAt) ?? ""
            allDay = try c.decodeIfPresent(Bool.self, forKey: .allDay) ?? false
            personId = try c.decodeIfPresent(String.self, forKey: .personId)
            personName = try c.decodeIfPresent(String.self, forKey: .personName)
            personColor = try c.decodeIfPresent(String.self, forKey: .personColor)
            participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, startsAt, allDay, personId, personName, personColor, participantIds
        }
    }

    struct PlanningNightDinner: Decodable, Sendable, Equatable {
        let entryId: String
        let title: String?
        let emoji: String?
        let recipeId: String?
        /// `recipeId == nil && mealId != nil` is the PLATE branch, checked first so a plate called
        /// "Takeout Tuesday" can't claim "no cooking".
        let mealId: String?
        let imageUrl: String?
        let cookName: String?
        let cookAvatar: String?
        let cookColor: String?
        let minutes: Int?
    }

    struct PlanningMealsNight: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        let events: [PlanningNightEvent]
        let dinner: PlanningNightDinner?

        var id: String { date }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            date = try c.decode(String.self, forKey: .date)
            events = try c.decodeIfPresent([PlanningNightEvent].self, forKey: .events) ?? []
            dinner = try c.decodeIfPresent(PlanningNightDinner.self, forKey: .dinner)
        }

        private enum CodingKeys: String, CodingKey { case date, events, dinner }
    }

    /// The grocery line — ONE line, not a panel. `nil` ⇒ the lists module is off.
    struct PlanningMealsGroceries: Decodable, Sendable, Equatable {
        let items: Int
        let checked: Int
    }

        /// Read back off a real one-off chore, so it also shows on the Tasks board. `personId ==
        /// nil` ⇒ planned but up for grabs, a real answer.
    struct PlanningShoppingTrip: Decodable, Sendable, Equatable {
        let choreId: String
        let personId: String?
        let personName: String?
        let personAvatar: String?
        let personColor: String?
        let dueOn: String
        let dueTime: String?
        let status: String
    }

    struct PlanningMealsView: Decodable, Sendable, Equatable {
        /// The week the SERVER named — snapped and floored. ECHO IT; never recompute one here.
        let weekStart: String
        let nights: [PlanningMealsNight]
        let emptyDates: [String]
        let groceries: PlanningMealsGroceries?
        /// False ⇒ the chores module is off: show the plain line and NO control, not a dead affordance.
        let choresOn: Bool
        let shopping: PlanningShoppingTrip?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            nights = try c.decodeIfPresent([PlanningMealsNight].self, forKey: .nights) ?? []
            emptyDates = try c.decodeIfPresent([String].self, forKey: .emptyDates) ?? []
            groceries = try c.decodeIfPresent(PlanningMealsGroceries.self, forKey: .groceries)
            choresOn = try c.decodeIfPresent(Bool.self, forKey: .choresOn) ?? false
            shopping = try c.decodeIfPresent(PlanningShoppingTrip.self, forKey: .shopping)
        }

        private enum CodingKeys: String, CodingKey {
            case weekStart, nights, emptyDates, groceries, choresOn, shopping
        }
    }

    /// What a fill wrote — and everything the undo needs to prove a night is still that. `mealId`
    /// IS PART OF THE PROOF: a plate is recipe-less with THE PLATE'S NAME as its title, so a filled
    /// title and a hand-picked plate of that name agree on `entryId`, `recipeId` and `title`.
    struct PlanningFilledNight: Decodable, Identifiable, Sendable, Equatable {
        let date: String
        let entryId: String
        let recipeId: String?
        let mealId: String?
        let title: String?

        var id: String { date }

        /// EXPLICIT `.null` for every absent field: building it with `if let` is how `mealId`
        /// quietly stops travelling, and it is the one dimension that tells a title from a plate.
        var json: JSONValue {
            .object([
                "date": .string(date),
                "entryId": .string(entryId),
                "recipeId": recipeId.map(JSONValue.string) ?? .null,
                "mealId": mealId.map(JSONValue.string) ?? .null,
                "title": title.map(JSONValue.string) ?? .null,
            ])
        }
    }

    struct PlanningMealsFill: Decodable, Sendable, Equatable {
        let weekStart: String
        let filled: [PlanningFilledNight]
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            filled = try c.decodeIfPresent([PlanningFilledNight].self, forKey: .filled) ?? []
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, filled, view }
    }

    struct PlanningMealsUndo: Decodable, Sendable, Equatable {
        let weekStart: String
        let cleared: [String]
        /// Nights left alone because somebody decided them since the fill — reported, not undone.
        let kept: [String]
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            cleared = try c.decodeIfPresent([String].self, forKey: .cleared) ?? []
            kept = try c.decodeIfPresent([String].self, forKey: .kept) ?? []
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, cleared, kept, view }
    }

    struct PlanningMealsShopperResult: Decodable, Sendable, Equatable {
        let weekStart: String
        let shopping: PlanningShoppingTrip?
        let view: PlanningMealsView

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            weekStart = try c.decodeIfPresent(String.self, forKey: .weekStart) ?? ""
            shopping = try c.decodeIfPresent(PlanningShoppingTrip.self, forKey: .shopping)
            view = try c.decode(PlanningMealsView.self, forKey: .view)
        }

        private enum CodingKeys: String, CodingKey { case weekStart, shopping, view }
    }

    // MARK: - The read and the three writes

    /// `choreId` is a HINT that keeps a renamed chore recognised instead of spawning a second.
    func planningMeals(weekStart: String, choreId: String? = nil) async throws -> PlanningMealsView {
        var path = "/api/weekly-planning/meals?weekStart=\(PlanningQuery.esc(weekStart))"
        if let choreId, !choreId.isEmpty { path += "&choreId=\(PlanningQuery.esc(choreId))" }
        return try await getJSON(path, as: PlanningMealsView.self)
    }

    /// Fills ONLY the nights with no dinner. See `PlanningMealsWire.fillBody` for the `cards` rule.
    func planningMealsFill(
        weekStart: String, cards: [PlanningMealsCard]? = nil
    ) async throws -> PlanningMealsFill {
        try await sendReturning(
            "POST", "/api/weekly-planning/meals/fill",
            body: PlanningMealsWire.fillBody(weekStart: weekStart, cards: cards),
            as: PlanningMealsFill.self)
    }

    func planningMealsUndo(
        weekStart: String, filled: [PlanningFilledNight]
    ) async throws -> PlanningMealsUndo {
        try await sendReturning(
            "POST", "/api/weekly-planning/meals/undo",
            body: PlanningMealsWire.undoBody(weekStart: weekStart, filled: filled),
            as: PlanningMealsUndo.self)
    }

    /// Assign the shopping trip, or clear it with `dueOn: nil` — an upsert, ONE chore per week. The
    /// server refuses a `dueOn` outside the week (400) and needs `chore.manage` for anybody else (403).
    func planningMealsSetShopper(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?
    ) async throws -> PlanningMealsShopperResult {
        try await sendReturning(
            "PUT", "/api/weekly-planning/meals/shopper",
            body: PlanningMealsWire.shopperBody(
                weekStart: weekStart, dueOn: dueOn, personId: personId,
                dueTime: dueTime, choreId: choreId),
            as: PlanningMealsShopperResult.self)
    }

    /// Only the four fields the fill writes: a client's `servings` or `note` is a claim nobody checks.
    struct PlanningMealsCard: Sendable, Equatable {
        let date: String
        /// The step plans DINNERS. A card naming another meal is DROPPED server-side.
        var mealType: String = "dinner"
        var title: String = ""
        var recipeId: String?

        var json: JSONValue {
            .object([
                "date": .string(date),
                "mealType": .string(mealType),
                "title": .string(title),
                "recipeId": recipeId.map(JSONValue.string) ?? .null,
            ])
        }
    }
}

/// The three bodies as PURE FUNCTIONS, so the one easy to get catastrophically wrong is testable.
enum PlanningMealsWire {

    /// `cards` IS THREE-WAY: **absent** (`nil` here ⇒ the key is not in the body) means the server
    /// drafts the empty nights, which is what iOS sends; **a real array** applies the approved week;
    /// **present but not a usable list** writes NOTHING. So never write
    /// `body["cards"] = cards.map(...) ?? .null` — the footer would report a week never planned.
    /// An EMPTY array is passed through rather than collapsed to absent, for the same reason.
    static func fillBody(
        weekStart: String, cards: [WaffledAPI.PlanningMealsCard]?
    ) -> [String: JSONValue] {
        var body: [String: JSONValue] = ["weekStart": .string(weekStart)]
        if let cards { body["cards"] = .array(cards.map(\.json)) }
        return body
    }

    /// The undo's claims, each round-tripped untouched — see `PlanningFilledNight.json`.
    static func undoBody(
        weekStart: String, filled: [WaffledAPI.PlanningFilledNight]
    ) -> [String: JSONValue] {
        ["weekStart": .string(weekStart), "filled": .array(filled.map(\.json))]
    }

    /// EXPLICIT NULLS, all three. `dueOn: null` is "no trip this week" (the chore is removed),
    /// `personId: null` is "up for grabs", `dueTime: null` is "no set time" — none of them means
    /// "leave it as it was", so an `if let` body would turn every clear into a silent no-op.
    static func shopperBody(
        weekStart: String, dueOn: String?, personId: String?, dueTime: String?, choreId: String?
    ) -> [String: JSONValue] {
        [
            "weekStart": .string(weekStart),
            "dueOn": dueOn.map(JSONValue.string) ?? .null,
            "personId": personId.map(JSONValue.string) ?? .null,
            "dueTime": dueTime.map(JSONValue.string) ?? .null,
            "choreId": choreId.map(JSONValue.string) ?? .null,
        ]
    }
}

/// Who may be handed the shopping trip, stated client-side so the picker never offers a tap the
/// server will refuse. The rule is the CHORES module's: somebody ELSE is `chore.manage`.
enum PlanningMealsShopper {
    static func mayAssign(personId: String?, myPersonId: String?, canManage: Bool) -> Bool {
        if canManage { return true }
        guard let personId else { return true }
        // A device with no person of its own (a kiosk identity) cannot claim "that's me".
        guard let myPersonId else { return false }
        return personId == myPersonId
    }
}
