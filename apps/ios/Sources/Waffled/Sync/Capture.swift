import Foundation

/// The parsed "Add anything" intent returned by `POST /api/capture`, mirroring the
/// web `ParsedIntent` union (apps/web/src/lib/capture/parse.ts). The server does the
/// understanding (pluggable LLM) and resolves dates to the household tz; we render
/// the preview and commit it.
enum CaptureIntent: Sendable, Equatable {
    case event(title: String, startsAt: String, allDay: Bool, personName: String?, rrule: String?, scheduleLabel: String, whenLabel: String)
    case grocery(name: String, quantity: String?)
    case task(title: String, personName: String?, stars: Int?, rrule: String?, scheduleLabel: String)
    case meal(title: String, date: String?, mealType: String, whenLabel: String)
    case list(itemName: String, listName: String?, quantity: String?)
    case countdown(title: String, date: String, emoji: String?, whenLabel: String)
    case person(name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Bool)
    case goal(title: String, goalType: String, targetValue: Double?, unit: String?, deadline: String?, trackingMode: String, audience: String?)
    case pantry(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?)
    case reward(title: String, emoji: String?, cost: Int?, currency: String?, category: String?, requiresApproval: Bool?)
    /// Tier 2 — a verb acting on an EXISTING row (complete/log/reschedule/reassign/redeem/
    /// delete). Unlike the create cases this isn't committed directly: `verb` + `targetKind`
    /// + `description` drive `/api/capture/resolve` to a list of candidate rows, one of which
    /// the user picks before `/api/capture/commit`. `args` is best-effort (date/time/amount/
    /// assignee) and refined server-side. Mirrors the web `ParsedIntent` mutate member.
    case mutate(verb: String, targetKind: String?, description: String, args: [String: JSONValue])
}

extension CaptureIntent: Decodable {
    private enum K: String, CodingKey {
        case kind, title, startsAt, allDay, personName, whenLabel
        case name, quantity, stars, rrule, scheduleLabel, date, mealType
        case itemName, listName, emoji
        case memberType, avatarEmoji, birthday, isAdmin
        case goalType, targetValue, unit, deadline, trackingMode, audience
        case amount, location, expiresOn, lowAt
        case cost, currency, category, requiresApproval
        case verb, targetKind, target, args, mutateArgs
    }

    /// The nested `target: { description }` object a mutate intent carries.
    private struct MutateTarget: Decodable { let description: String }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "event":
            self = .event(
                title: try c.decode(String.self, forKey: .title),
                startsAt: try c.decode(String.self, forKey: .startsAt),
                allDay: (try? c.decode(Bool.self, forKey: .allDay)) ?? false,
                personName: try c.decodeIfPresent(String.self, forKey: .personName),
                rrule: try c.decodeIfPresent(String.self, forKey: .rrule),
                scheduleLabel: (try? c.decode(String.self, forKey: .scheduleLabel)) ?? "",
                whenLabel: (try? c.decode(String.self, forKey: .whenLabel)) ?? ""
            )
        case "grocery":
            self = .grocery(
                name: try c.decode(String.self, forKey: .name),
                quantity: try c.decodeIfPresent(String.self, forKey: .quantity)
            )
        case "task":
            self = .task(
                title: try c.decode(String.self, forKey: .title),
                personName: try c.decodeIfPresent(String.self, forKey: .personName),
                stars: try c.decodeIfPresent(Int.self, forKey: .stars),
                rrule: try c.decodeIfPresent(String.self, forKey: .rrule),
                scheduleLabel: (try? c.decode(String.self, forKey: .scheduleLabel)) ?? ""
            )
        case "meal":
            self = .meal(
                title: try c.decode(String.self, forKey: .title),
                date: try c.decodeIfPresent(String.self, forKey: .date),
                mealType: (try? c.decode(String.self, forKey: .mealType)) ?? "dinner",
                whenLabel: (try? c.decode(String.self, forKey: .whenLabel)) ?? ""
            )
        case "list":
            self = .list(
                itemName: try c.decode(String.self, forKey: .itemName),
                listName: try c.decodeIfPresent(String.self, forKey: .listName),
                quantity: try c.decodeIfPresent(String.self, forKey: .quantity)
            )
        case "countdown":
            self = .countdown(
                title: try c.decode(String.self, forKey: .title),
                date: try c.decode(String.self, forKey: .date),
                emoji: try c.decodeIfPresent(String.self, forKey: .emoji),
                whenLabel: (try? c.decode(String.self, forKey: .whenLabel)) ?? ""
            )
        case "person":
            self = .person(
                name: try c.decode(String.self, forKey: .name),
                memberType: (try? c.decode(String.self, forKey: .memberType)) ?? "adult",
                avatarEmoji: try c.decodeIfPresent(String.self, forKey: .avatarEmoji),
                birthday: try c.decodeIfPresent(String.self, forKey: .birthday),
                isAdmin: (try? c.decode(Bool.self, forKey: .isAdmin)) ?? false
            )
        case "goal":
            self = .goal(
                title: try c.decode(String.self, forKey: .title),
                goalType: (try? c.decode(String.self, forKey: .goalType)) ?? "habit",
                targetValue: try? c.decode(Double.self, forKey: .targetValue),
                unit: try c.decodeIfPresent(String.self, forKey: .unit),
                deadline: try c.decodeIfPresent(String.self, forKey: .deadline),
                trackingMode: (try? c.decode(String.self, forKey: .trackingMode)) ?? "shared_total",
                audience: try c.decodeIfPresent(String.self, forKey: .audience)
            )
        case "pantry":
            self = .pantry(
                name: try c.decode(String.self, forKey: .name),
                amount: try c.decodeIfPresent(String.self, forKey: .amount),
                unit: try c.decodeIfPresent(String.self, forKey: .unit),
                location: (try? c.decode(String.self, forKey: .location)) ?? "Pantry",
                expiresOn: try c.decodeIfPresent(String.self, forKey: .expiresOn),
                lowAt: try? c.decode(Double.self, forKey: .lowAt)
            )
        case "reward":
            self = .reward(
                title: try c.decode(String.self, forKey: .title),
                emoji: try c.decodeIfPresent(String.self, forKey: .emoji),
                cost: try? c.decode(Int.self, forKey: .cost),
                currency: try c.decodeIfPresent(String.self, forKey: .currency),
                category: try c.decodeIfPresent(String.self, forKey: .category),
                requiresApproval: try? c.decode(Bool.self, forKey: .requiresApproval)
            )
        case "mutate":
            // `args` is the current key; `mutateArgs` is the legacy alias the server may
            // still emit (web normalizes both). Missing/malformed → an empty map.
            let args = (try? c.decode([String: JSONValue].self, forKey: .args))
                ?? (try? c.decode([String: JSONValue].self, forKey: .mutateArgs)) ?? [:]
            self = .mutate(
                verb: try c.decode(String.self, forKey: .verb),
                targetKind: try c.decodeIfPresent(String.self, forKey: .targetKind),
                description: (try c.decode(MutateTarget.self, forKey: .target)).description,
                args: args
            )
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c,
                debugDescription: "Unknown intent kind: \(other)")
        }
    }
}

/// A glanceable preview of an intent (icon + kind + primary + detail) — the SwiftUI
/// equivalent of the web `intentSummary`.
struct CaptureSummary {
    let icon: String
    let kind: String
    let primary: String
    let detail: String

    init(_ intent: CaptureIntent) {
        switch intent {
        case let .event(title, _, _, personName, _, scheduleLabel, whenLabel):
            icon = "📅"; kind = "Event"; primary = title
            detail = [whenLabel, scheduleLabel, personName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        case let .grocery(name, quantity):
            icon = "🛒"; kind = "Grocery"
            primary = [quantity, name].compactMap { $0 }.joined(separator: " ")
            detail = "Adds to the grocery list"
        case let .task(title, personName, stars, _, scheduleLabel):
            icon = "✅"; kind = "Task"; primary = title
            detail = [personName ?? "Up for grabs", scheduleLabel, stars.map { "\($0)★" } ?? ""]
                .filter { !$0.isEmpty }.joined(separator: " · ")
        case let .meal(title, _, _, whenLabel):
            icon = "🍽️"; kind = "Meal"; primary = title; detail = "\(whenLabel) · meal plan"
        case let .list(itemName, listName, quantity):
            icon = "📝"; kind = "List"
            primary = [quantity, itemName].compactMap { $0 }.joined(separator: " ")
            detail = listName.map { "Adds to \($0)" } ?? "Adds to a list"
        case let .countdown(title, _, _, whenLabel):
            icon = "⏳"; kind = "Countdown"; primary = title; detail = whenLabel
        case let .person(name, memberType, avatarEmoji, _, _):
            icon = avatarEmoji ?? "👤"; kind = "Family member"; primary = name
            detail = memberType == "kid" ? "Kid" : (memberType == "teen" ? "Teen" : "Adult")
        case let .goal(title, goalType, targetValue, unit, deadline, _, _):
            icon = "🎯"; kind = "Goal"; primary = title
            let typeLabel = goalType == "count" ? "Count" : (goalType == "total" ? "Total" : (goalType == "checklist" ? "Checklist" : "Habit"))
            let target = targetValue.map { tv -> String in
                let n = tv == tv.rounded() ? String(Int(tv)) : String(tv)
                return unit.map { "\(n) \($0)" } ?? n
            }
            detail = [typeLabel, target, deadline.map { "by \($0)" }]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        case let .pantry(name, amount, unit, location, expiresOn, _):
            icon = "🥫"; kind = "Pantry"
            primary = [amount, unit, name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            detail = ["Adds to \(location)", expiresOn.map { "expires \($0)" }]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        case let .reward(title, emoji, cost, _, _, requiresApproval):
            icon = emoji ?? "🎁"; kind = "Reward"; primary = title
            detail = ["Adds to the reward shop", cost.map { "\($0)★" }, requiresApproval == true ? "needs approval" : nil]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        case let .mutate(verb, targetKind, description, _):
            icon = MutateLabels.icon(verb); kind = MutateLabels.verbLabel(verb)
            primary = description
            detail = MutateLabels.targetLabel(targetKind)
        }
    }
}

/// Display copy for a Tier 2 mutate — icon, verb title, and target-kind noun. Mirrors the
/// web `mutateIcon` / `mutateVerbLabel` / `mutateTargetLabel` (parse.ts) so the iOS preview
/// reads the same as the kiosk.
enum MutateLabels {
    static func icon(_ verb: String) -> String {
        switch verb {
        case "complete": return "✅"
        case "log": return "📈"
        case "reschedule": return "📅"
        case "reassign": return "🔄"
        case "redeem": return "⭐"
        case "delete": return "🗑️"
        default: return "✨"
        }
    }
    static func verbLabel(_ verb: String) -> String {
        switch verb {
        case "complete": return "Mark done"
        case "log": return "Log progress"
        case "reschedule": return "Reschedule"
        case "reassign": return "Reassign"
        case "redeem": return "Redeem"
        case "delete": return "Delete"
        default: return "Update"
        }
    }
    static func targetLabel(_ targetKind: String?) -> String {
        switch targetKind {
        case "chore": return "chore"
        case "goal": return "goal"
        case "listItem": return "list item"
        case "event": return "event"
        case "reward": return "reward"
        default: return "match"
        }
    }
    /// The confirm-button label per verb (mirrors the web `CONFIRM_LABEL`).
    static func confirmLabel(_ verb: String) -> String {
        switch verb {
        case "complete": return "Mark done"
        case "log": return "Log it"
        case "reschedule": return "Reschedule"
        case "reassign": return "Reassign"
        case "redeem": return "Redeem"
        case "delete": return "Delete it"
        default: return "Do it"
        }
    }
    /// Copy for an empty resolve (mirrors the web CandidatePicker). `unsupported` means the
    /// ACTION can't run — show only a capability message, never "Couldn't find…", which would
    /// wrongly tell the user the item doesn't exist. The reason can be absent on a
    /// version-skewed server, so the fallback keys off `unsupported` alone.
    static func emptyHint(unsupported: Bool, disabledReason: String?, targetKind: String?) -> String {
        if unsupported { return disabledReason ?? "Quick-add can't do that yet." }
        return "Couldn't find a \(targetLabel(targetKind)) like that"
            + (disabledReason.map { " — \($0)" } ?? "")
    }
}

/// The resolved state of a mutate — the candidate rows plus the degrade info the sheet
/// renders. Mirrors the web `CandidateState`: the three "empty" cases are distinguished by
/// `unsupported` + `disabledReason`, and `offline` flags a resolve call that itself failed.
/// `forKey` (verb|targetKind|description) guards against a stale result overwriting a newer parse.
struct MutateResolveState: Sendable, Equatable {
    var candidates: [WaffledAPI.Candidate]
    var disabledReason: String?
    var unsupported: Bool
    var offline: Bool
    var forKey: String
}
