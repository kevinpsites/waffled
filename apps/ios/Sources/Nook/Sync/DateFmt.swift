import Foundation

/// Date → string formatting in a given timezone, centralized so views don't each
/// hand-roll a `DateFormatter` (and risk the wrong tz or locale). Uses a fixed
/// POSIX locale so format strings render stably. Pairs with `EventTime` (parsing)
/// and `Agenda` (day bucketing).
enum DateFmt {
    static func string(_ date: Date, _ pattern: String, _ tz: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = tz
        f.dateFormat = pattern
        return f.string(from: date)
    }
}
