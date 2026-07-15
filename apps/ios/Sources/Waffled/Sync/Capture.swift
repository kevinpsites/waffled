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
    case goal(title: String, goalType: String, targetValue: Double?, unit: String?, deadline: String?, trackingMode: String)
    case pantry(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double?)
    case reward(title: String, emoji: String?, cost: Int?, currency: String?, category: String?, requiresApproval: Bool?)
}

extension CaptureIntent: Decodable {
    private enum K: String, CodingKey {
        case kind, title, startsAt, allDay, personName, whenLabel
        case name, quantity, stars, rrule, scheduleLabel, date, mealType
        case itemName, listName, emoji
        case memberType, avatarEmoji, birthday, isAdmin
        case goalType, targetValue, unit, deadline, trackingMode
        case amount, location, expiresOn, lowAt
        case cost, currency, category, requiresApproval
    }

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
                trackingMode: (try? c.decode(String.self, forKey: .trackingMode)) ?? "shared_total"
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
        case let .goal(title, goalType, targetValue, unit, deadline, _):
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
        }
    }
}
