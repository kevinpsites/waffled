import Foundation

/// Per-goal "last selected data view" — mirrors the web's localStorage key
/// (`waffled.goalView.<goalId>`) and this codebase's existing UserDefaults
/// per-item pattern (see HealthSyncMark).
enum GoalViewPreference {
    private static func key(_ goalId: String) -> String { "waffled.goalView.\(goalId)" }

    static func get(_ goalId: String, defaults: UserDefaults = .standard) -> GoalViewKey? {
        defaults.string(forKey: key(goalId)).flatMap(GoalViewKey.init(rawValue:))
    }

    static func set(_ goalId: String, _ view: GoalViewKey, defaults: UserDefaults = .standard) {
        defaults.set(view.rawValue, forKey: key(goalId))
    }
}
