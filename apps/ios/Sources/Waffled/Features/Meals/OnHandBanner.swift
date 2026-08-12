import Foundation

/// The copy for the recipe screen's "N of M on hand — need X, Y" line.
///
/// Pulled out of the view so the rule it encodes is testable, because getting it wrong
/// is quiet: the banner previously counted `ingredients.isStaple`, which never touches
/// the pantry at all. A staple is something a household is assumed to keep around, not
/// something it currently has — so an empty pantry still reported "4 of 9 on hand".
/// The counts now come from the server's real pantry matching.
enum OnHandBanner {
    struct Copy: Equatable {
        /// The bold "4 of 9". **nil means make no on-hand claim at all** — render
        /// nothing, not "0 of 9", which reads as "you have none of these" and is a
        /// different (and equally untrue) statement.
        let lead: String?
        let tail: String
        let showsAddButton: Bool
    }

    /// - Parameters:
    ///   - onHand: the server's real pantry match; nil when the pantry module is off.
    ///   - toBuy: nil only from a server predating these counts — distinct from 0, so
    ///     "we weren't told" can't be mistaken for "nothing is needed".
    ///   - toBuyNames: what will actually land on the list. With the pantry ON this is
    ///     the *unmatched* subset, which no client could derive from the ingredients.
    ///   - nonStapleNames: the old client-side split, used only for the legacy fallback.
    static func copy(onHand: WaffledAPI.OnHandCount?, toBuy: Int?, toBuyNames: [String],
                     nonStapleNames: [String]) -> Copy {
        let missing = toBuy == nil ? nonStapleNames : toBuyNames
        let need: String = {
            guard !missing.isEmpty else { return "" }
            let shown = missing.prefix(3).joined(separator: ", ")
            let extra = missing.count > 3 ? " +\(missing.count - 3) more" : ""
            return "need \(shown)\(extra)"
        }()
        guard let onHand else {
            // No pantry answer — talk only about the shopping, never about having.
            return Copy(lead: nil,
                        tail: missing.isEmpty
                            ? "Nothing to buy — it’s all pantry staples"
                            : need.prefix(1).uppercased() + need.dropFirst(),
                        showsAddButton: !missing.isEmpty)
        }
        return Copy(lead: "\(onHand.have) of \(onHand.total)",
                    tail: missing.isEmpty ? " on hand — you’ve got everything" : " on hand — \(need)",
                    showsAddButton: !missing.isEmpty)
    }
}
