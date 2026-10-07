import Foundation

/// Reading `data.routes` off a step record. Step 1's routing decisions are persisted as
/// free-form JSON on its own step row, so getting them back means decoding a `JSONValue`.
/// One implementation, because the tolerance rule below only stays true in one place.
enum PlanningRouteSeed {

    /// Decode a `data.routes` value into routes, TOLERANTLY: one unreadable row must cost
    /// that row and nothing else. The server's own guard only checks `kind`/`id`/`to`, so a
    /// row from an older build can lack `title` or `source` — and a strict decode would
    /// throw away every route the family triaged on the strength of one bad element.
    ///
    /// Returns `[]` for absent, null, or anything that isn't an array.
    static func decode(_ value: JSONValue?) -> [WaffledAPI.LooseEndRoute] {
        guard let value, case let .array(items) = value else { return [] }
        return items.compactMap { item in
            guard let bytes = try? JSONEncoder().encode(item) else { return nil }
            return try? WaffledAPI.decoder.decode(WaffledAPI.LooseEndRoute.self, from: bytes)
        }
    }

    static func addressed(to stepKey: String, in routes: [WaffledAPI.LooseEndRoute]) -> [WaffledAPI.LooseEndRoute] {
        routes.filter { $0.to == stepKey }
    }

    /// A route's identity, `"chore:<uuid>"` — never the title, because two loose ends can read
    /// the same.
    static func key(_ route: WaffledAPI.LooseEndRoute) -> String { "\(route.kind):\(route.id)" }

    /// WHAT GOES IN THE ROUTED HALF OF THE STEP'S "SENT HERE" BOX. The shell's
    /// `PlanningHandoffBanner` draws one box per step and there are two ways in: a PARKED
    /// NOTE on `step.parked`, and a ROUTED LOOSE END in step 1's `data.routes`. Four rules,
    /// in one place because they are all about the same double-show:
    ///
    ///  1. **Addressed here.** `to == stepKey`.
    ///  2. **Not already in the box as a note** — routing a parked note also sets its
    ///     `step_key`, so it arrives through BOTH doors. Matched on the note's ID, not on
    ///     `kind == "parked"`: `parkedByStep` caps the box at six, and suppressing the
    ///     route row of a note that fell off that cap would lose it entirely.
    ///  3. **Not a step that draws its own** (Kids, and step 1 itself).
    ///  4. **Not already acted on.** `settled` holds the `key(_:)`s this sitting used up.
    ///
    /// `parked` is the RAW handoff list, not the banner's locally-hidden view: answering
    /// "Handled" must not make a note's routed twin pop into existence.
    static func sentHere(
        to stepKey: String,
        in routes: [WaffledAPI.LooseEndRoute],
        parked: [WaffledAPI.PlanningStepHandoff]?,
        settled: Set<String>
    ) -> [WaffledAPI.LooseEndRoute] {
        guard drawsItsOwn.contains(stepKey) == false else { return [] }
        let notes = Set((parked ?? []).map(\.id))
        return addressed(to: stepKey, in: routes).filter { route in
            if route.kind == "parked" && notes.contains(route.id) { return false }
            return !settled.contains(key(route))
        }
    }

    /// The steps whose own body already shows what was routed to them. See rule 3 above.
    private static let drawsItsOwn: Set<String> = ["kids", "looseEnds"]
}
