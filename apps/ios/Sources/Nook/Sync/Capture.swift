import Foundation

/// The parsed "Add anything" intent returned by `POST /api/capture`, mirroring the
/// web `ParsedIntent` union (apps/web/src/lib/capture/parse.ts). The server does the
/// understanding (pluggable LLM) and resolves dates to the household tz; we render
/// the preview and commit it.
enum CaptureIntent: Sendable, Equatable {
    case event(title: String, startsAt: String, allDay: Bool, personName: String?, whenLabel: String)
    case grocery(name: String, quantity: String?)
    case task(title: String, personName: String?, stars: Int?, rrule: String?, scheduleLabel: String)
    case meal(title: String, date: String?, mealType: String, whenLabel: String)
}

extension CaptureIntent: Decodable {
    private enum K: String, CodingKey {
        case kind, title, startsAt, allDay, personName, whenLabel
        case name, quantity, stars, rrule, scheduleLabel, date, mealType
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
        case let .event(title, _, _, personName, whenLabel):
            icon = "📅"; kind = "Event"; primary = title
            detail = [whenLabel, personName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
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
        }
    }
}
