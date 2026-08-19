import Foundation

/// Remembers the household's `week_start` between launches.
///
/// The value's real home is the synced `households` row, which only lands on a sync
/// tick — so without this there is a window at every cold launch where the app has to
/// guess. That window is not theoretical: `GroceryWeeks.weekStarts` cuts grocery rebuild
/// calls on this, so applying a month plan in the first seconds of a launch in a
/// **monday** household grouped the weeks on Sundays and rebuilt the wrong ones. (The
/// server snaps a mid-week `?weekStart=` to the household boundary, so nothing errors —
/// the list is just quietly wrong.)
///
/// Remembering the last answer is strictly better than re-guessing it: a household that
/// has ever synced launches knowing, and only a never-synced install falls back.
///
/// Deliberately returns `Optional`. "We have never synced" and "this household starts on
/// Sunday" are different facts that happen to lead to the same behaviour today; folding
/// them together here would hide the first from the caller — and from any test of it.
enum HouseholdWeekStartStore {
    /// Dot-form, matching the app's other UserDefaults keys (`waffled.theme`,
    /// `waffled.screensaverMotion`). The web's localStorage colon form is its own
    /// convention; this side has never used it.
    static let key = "waffled.householdWeekStart"

    /// The last value a sync tick reported, or `nil` if none was ever stored.
    ///
    /// Unrecognised text reads as `nil` rather than falling through to Sunday. This is a
    /// value *we* wrote, so anything else is corruption, and inventing a week start out
    /// of corruption is how you get a silently wrong grocery week. (`HouseholdWeekStart
    /// .init(raw:)` stays lenient for its own job — free text off the synced row.)
    static func load(defaults: UserDefaults = .standard) -> HouseholdWeekStart? {
        defaults.string(forKey: key).flatMap(HouseholdWeekStart.init(rawValue:))
    }

    static func save(_ value: HouseholdWeekStart, defaults: UserDefaults = .standard) {
        defaults.set(value.rawValue, forKey: key)
    }

    /// Take the value a sync tick reported, remember it, and hand back what to use.
    ///
    /// Reading and remembering are deliberately ONE call. As two steps, dropping the save
    /// from the call site compiled, ran, and passed every test — silently re-opening the
    /// cold-launch window this type exists to close. The save is unconditional on purpose:
    /// gating it on "did the value change" means a sunday household, whose synced value
    /// matches the fallback, never records that it synced at all.
    @discardableResult
    static func adopt(_ raw: String?, defaults: UserDefaults = .standard) -> HouseholdWeekStart {
        let value = HouseholdWeekStart(raw: raw)
        save(value, defaults: defaults)
        return value
    }
}
