import Foundation
import Observation
import UserNotifications

/// Local event reminders (roadmap 6.7-ios). Schedules on-device notifications from
/// the synced `events` mirror — no server, no APNs, no Apple key — so reminders fire
/// even when the app is closed and offline.
///
/// iOS caps *pending* local notifications at 64, so we schedule a rolling near-term
/// horizon (soonest-firing first, capped under the limit) and reconcile on every
/// events change / foreground. Identifiers are stable (`nook.evt.<id>`) so a re-sync
/// replaces rather than duplicates; an edited/deleted event drops out on the next pass.
@MainActor
@Observable
final class NotificationManager {
    // Per-user preferences, persisted to UserDefaults. Setting any of these
    // re-reconciles against the last known events (see `apply`).
    var enabled: Bool { didSet { d.set(enabled, forKey: K.enabled); changed() } }
    var leadMinutes: Int { didSet { d.set(leadMinutes, forKey: K.lead); changed() } }
    var allDayHour: Int { didSet { d.set(allDayHour, forKey: K.allDayHour); changed() } }
    var myEventsOnly: Bool { didSet { d.set(myEventsOnly, forKey: K.myOnly); changed() } }

    /// Set when the user taps a reminder; AppRoot observes this to deep-link to the
    /// event, then clears it.
    var pendingEventId: String?

    /// Whether iOS has granted permission — drives the Settings hint.
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// How many upcoming reminders were dropped by the 64-pending cap last pass
    /// (surfaced in Settings so the horizon limit is never silent).
    private(set) var droppedToCap = 0

    // Cached reconcile inputs, so a preference toggle can re-run without the caller.
    private var lastEvents: [SyncedEvent] = []
    private var lastTz: TimeZone = .current
    private var lastMyPersonId: String?
    private var lastNames: [String: String] = [:]

    private let center = UNUserNotificationCenter.current()
    private let delegate = NotifDelegate()
    private let d = UserDefaults.standard

    private enum K {
        static let enabled = "nook.notif.enabled"
        static let lead = "nook.notif.leadMinutes"
        static let allDayHour = "nook.notif.allDayHour"
        static let myOnly = "nook.notif.myEventsOnly"
    }
    /// Identifier namespace for auto-scheduled reminders — lets us reconcile *only*
    /// those (a user's snooze, below, lives under a different prefix so reconcile
    /// never cancels it).
    static let idPrefix = "nook.evt."
    /// A snoozed reminder — separate namespace so the reconcile loop leaves it alone.
    static let snoozePrefix = "nook.snz."
    /// Category carrying the Snooze / View actions on each reminder.
    static let categoryId = "EVENT_REMINDER"
    static let snoozeMinutes = 10
    /// Headroom under the iOS 64-pending cap.
    private static let maxScheduled = 58

    init() {
        enabled = d.bool(forKey: K.enabled)                       // default off
        leadMinutes = d.object(forKey: K.lead) as? Int ?? 15      // 15 min before
        allDayHour = d.object(forKey: K.allDayHour) as? Int ?? 8  // 8:00 AM
        myEventsOnly = d.object(forKey: K.myOnly) as? Bool ?? true
        delegate.manager = self
        center.delegate = delegate
        center.setNotificationCategories([Self.reminderCategory()])
        // A dead refresh token signs us out — drop any reminders for the old session.
        NotificationCenter.default.addObserver(forName: .nookAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.clearOurs() }
        }
    }

    /// Snooze + View actions shown when a reminder is expanded/long-pressed.
    private static func reminderCategory() -> UNNotificationCategory {
        let snooze = UNNotificationAction(identifier: "SNOOZE", title: "Snooze \(snoozeMinutes) min", options: [])
        let view = UNNotificationAction(identifier: "VIEW", title: "View", options: [.foreground])
        return UNNotificationCategory(identifier: categoryId, actions: [snooze, view],
                                      intentIdentifiers: [], options: [])
    }

    // MARK: authorization

    func refreshAuthorization() async {
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Prompt for permission (no-op if already decided), then reconcile.
    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshAuthorization()
        await apply()
        return granted
    }

    // MARK: reconcile

    /// Re-evaluate scheduled reminders from the latest synced events. Caches the
    /// inputs so a later preference change can reconcile on its own.
    func reconcile(events: [SyncedEvent], tz: TimeZone, myPersonId: String?, names: [String: String]) async {
        lastEvents = events; lastTz = tz; lastMyPersonId = myPersonId; lastNames = names
        await apply()
    }

    private func changed() { Task { await apply() } }

    private func apply() async {
        // Off or not allowed → tear our reminders down and stop.
        guard enabled, authorization == .authorized || authorization == .provisional else {
            await clearOurs()
            droppedToCap = 0
            return
        }

        let now = Date()
        var planned: [(id: String, content: UNNotificationContent, fire: Date)] = []
        for e in lastEvents {
            if myEventsOnly, let mine = lastMyPersonId,
               !(e.personId == mine || e.participantIds.contains(mine)) { continue }
            guard let fire = fireDate(for: e), fire > now else { continue }
            planned.append((Self.idPrefix + e.id, content(for: e), fire))
        }
        planned.sort { $0.fire < $1.fire }
        let keep = Array(planned.prefix(Self.maxScheduled))
        droppedToCap = planned.count - keep.count
        if droppedToCap > 0 {
            // Never a silent cap — the horizon is genuinely limited by iOS.
            print("NotificationManager: \(droppedToCap) reminder(s) beyond the \(Self.maxScheduled)-slot horizon were not scheduled")
        }

        // Reconcile against the reminders we currently own.
        let desiredIds = Set(keep.map(\.id))
        let existing = await ourPendingIds()
        let stale = existing.subtracting(desiredIds)
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: Array(stale)) }
        for p in keep {
            // A one-shot time-interval trigger fires at the right absolute instant;
            // re-adding with the same id replaces, keeping reconcile idempotent.
            let interval = max(1, p.fire.timeIntervalSinceNow)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
            let req = UNNotificationRequest(identifier: p.id, content: p.content, trigger: trigger)
            try? await center.add(req)
        }
    }

    /// Drop every reminder we own — auto-scheduled *and* snoozed (e.g. on sign-out or
    /// when reminders are disabled).
    func clearOurs() async {
        let reqs = await center.pendingNotificationRequests()
        let ids = reqs.map(\.identifier).filter { $0.hasPrefix("nook.") }
        if !ids.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ids) }
    }

    // MARK: building reminders

    /// When a reminder for this event should fire, or nil if it can't be timed.
    private func fireDate(for e: SyncedEvent) -> Date? {
        if e.allDay { return allDayFire(e) }
        guard let start = e.startsAt else { return nil }
        return start.addingTimeInterval(TimeInterval(-leadMinutes * 60))
    }

    /// All-day events fire at the configured morning hour, in the household tz.
    private func allDayFire(_ e: SyncedEvent) -> Date? {
        let key = Agenda.dayKey(e, lastTz)            // "YYYY-MM-DD"
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = lastTz
        var c = DateComponents()
        c.year = parts[0]; c.month = parts[1]; c.day = parts[2]; c.hour = allDayHour
        return cal.date(from: c)
    }

    private func content(for e: SyncedEvent) -> UNNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = e.title
        var bits: [String] = []
        if e.allDay {
            bits.append("All day")
        } else if let s = e.startsAt {
            bits.append(EventTime.timeLabel(s, lastTz))
        }
        if let loc = e.location?.trimmingCharacters(in: .whitespaces), !loc.isEmpty { bits.append(loc) }
        // When showing the whole household, name whose event it is.
        if !myEventsOnly, let pid = e.personId, let name = lastNames[pid] { bits.append(name) }
        c.body = bits.joined(separator: " · ")
        c.sound = .default
        c.threadIdentifier = "nook-events"
        c.categoryIdentifier = Self.categoryId
        c.userInfo = ["eventId": e.id]
        return c
    }

    /// Re-deliver a reminder `snoozeMinutes` from now (from the Snooze action). Reuses
    /// the original content under the snooze namespace so reconcile won't cancel it.
    func snooze(eventId: String, content: UNNotificationContent) async {
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval(Self.snoozeMinutes * 60), repeats: false)
        let req = UNNotificationRequest(identifier: Self.snoozePrefix + eventId, content: content, trigger: trigger)
        try? await center.add(req)
    }

    private func ourPendingIds() async -> Set<String> {
        let reqs = await center.pendingNotificationRequests()
        return Set(reqs.map(\.identifier).filter { $0.hasPrefix(Self.idPrefix) })
    }
}

/// Plain `NSObject` delegate so `NotificationManager` stays a clean `@Observable`.
/// Captures the tapped event for deep-linking and shows banners in the foreground.
private final class NotifDelegate: NSObject, UNUserNotificationCenterDelegate {
    weak var manager: NotificationManager?

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        let id = content.userInfo["eventId"] as? String
        switch response.actionIdentifier {
        case "SNOOZE":
            Task { @MainActor in
                if let id { await manager?.snooze(eventId: id, content: content) }
                completionHandler()
            }
        default:   // default tap or the "View" action → deep-link to the event
            Task { @MainActor in manager?.pendingEventId = id; completionHandler() }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
