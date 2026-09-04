import Foundation
import Observation
import UserNotifications

/// Local event reminders (roadmap 6.7-ios). Schedules on-device notifications from
/// the synced `events` mirror — no server, no APNs, no Apple key — so reminders fire
/// even when the app is closed and offline.
///
/// iOS caps *pending* local notifications at 64, so we schedule a rolling near-term
/// horizon (soonest-firing first, capped under the limit) and reconcile on every
/// events change / foreground. Identifiers are stable (`waffled.evt.<id>`) so a re-sync
/// replaces rather than duplicates; an edited/deleted event drops out on the next pass.
@MainActor
@Observable
final class NotificationManager {
    /// Non-secret ownership marker embedded in every notification payload. It lets a
    /// delegate callback that was already queued by iOS reject an old household's tap
    /// after a session/server replacement.
    struct PrincipalContext: Equatable, Sendable {
        let identityScope: String
        let apiBaseURL: String

        static var current: PrincipalContext? {
            guard !AppConfig.principalIsolationRequired,
                  let identityScope = AppConfig.currentIdentityScope else { return nil }
            return PrincipalContext(
                identityScope: identityScope,
                apiBaseURL: AppConfig.apiBaseURL
            )
        }

        var isCurrent: Bool { Self.current == self }

        private static let scopeKey = "waffledPrincipalScope"
        private static let baseURLKey = "waffledPrincipalBaseURL"

        func stamp(_ info: inout [String: Any]) {
            info[Self.scopeKey] = identityScope
            info[Self.baseURLKey] = apiBaseURL
        }

        static func decode(_ info: [AnyHashable: Any]) -> PrincipalContext? {
            guard let identityScope = info[scopeKey] as? String,
                  let apiBaseURL = info[baseURLKey] as? String else { return nil }
            return PrincipalContext(identityScope: identityScope, apiBaseURL: apiBaseURL)
        }
    }

    // Per-user preferences, persisted to UserDefaults. Setting any of these
    // re-reconciles against the last known events (see `apply`).
    var enabled: Bool { didSet { d.set(enabled, forKey: K.enabled); changed() } }
    var leadMinutes: Int { didSet { d.set(leadMinutes, forKey: K.lead); changed() } }
    var allDayHour: Int { didSet { d.set(allDayHour, forKey: K.allDayHour); changed() } }
    var myEventsOnly: Bool { didSet { d.set(myEventsOnly, forKey: K.myOnly); changed() } }

    /// Set when the user taps a reminder; AppRoot observes this to deep-link to the
    /// event, then clears it.
    var pendingEventId: String?

    /// Set when the user taps a fired cook-mode timer notification; `RootView` observes
    /// this to re-open Cook Mode at the right recipe + step, then clears it. Kept in a
    /// separate namespace from `pendingEventId` so the two deep-links never collide.
    var pendingCookTimer: CookTimerLink?

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
    private let clearSystemPrincipalArtifacts: @MainActor () async -> Void
    private let addSystemNotification: @MainActor (UNNotificationRequest) async -> Void
    private let removeSystemNotifications: @MainActor ([String]) async -> Void
    private var principalCleanupInProgress = false
    private var principalCleanupWaiters: [CheckedContinuation<Void, Never>] = []
    private var activeSystemMutations = 0
    private var systemMutationDrainWaiters: [CheckedContinuation<Void, Never>] = []
    /// Cook timer add/remove calls originate from synchronous UI actions. Keep them in
    /// submission order while still accounting for every queued call in the principal
    /// cleanup drain. In particular, a pause/remove queued behind a suspended add must
    /// run after that add, not race it and leave the notification behind.
    private var cookTimerMutationTail: Task<Void, Never>?
    private var cookTimerMutationTailID: UUID?

    private enum K {
        static let enabled = "waffled.notif.enabled"
        static let lead = "waffled.notif.leadMinutes"
        static let allDayHour = "waffled.notif.allDayHour"
        static let myOnly = "waffled.notif.myEventsOnly"
    }
    /// Identifier namespace for auto-scheduled reminders — lets us reconcile *only*
    /// those (a user's snooze, below, lives under a different prefix so reconcile
    /// never cancels it).
    nonisolated static let idPrefix = "waffled.evt."
    /// A snoozed reminder — separate namespace so the reconcile loop leaves it alone.
    nonisolated static let snoozePrefix = "waffled.snz."
    /// Category carrying the Snooze / View actions on each reminder.
    static let categoryId = "EVENT_REMINDER"
    static let snoozeMinutes = 10
    /// Headroom under the iOS 64-pending cap.
    private static let maxScheduled = 58

    init(
        clearSystemPrincipalArtifacts: (@MainActor () async -> Void)? = nil,
        addSystemNotification: (@MainActor (UNNotificationRequest) async -> Void)? = nil,
        removeSystemNotifications: (@MainActor ([String]) async -> Void)? = nil
    ) {
        let systemCenter = UNUserNotificationCenter.current()
        self.clearSystemPrincipalArtifacts = clearSystemPrincipalArtifacts ?? {
            systemCenter.removeAllPendingNotificationRequests()
            systemCenter.removeAllDeliveredNotifications()
            try? await systemCenter.setBadgeCount(0)
        }
        self.addSystemNotification = addSystemNotification ?? { request in
            try? await systemCenter.add(request)
        }
        self.removeSystemNotifications = removeSystemNotifications ?? { ids in
            systemCenter.removePendingNotificationRequests(withIdentifiers: ids)
            systemCenter.removeDeliveredNotifications(withIdentifiers: ids)
        }
        enabled = d.bool(forKey: K.enabled)                       // default off
        leadMinutes = d.object(forKey: K.lead) as? Int ?? 15      // 15 min before
        allDayHour = d.object(forKey: K.allDayHour) as? Int ?? 8  // 8:00 AM
        myEventsOnly = d.object(forKey: K.myOnly) as? Bool ?? true
        delegate.manager = self
        center.delegate = delegate
        center.setNotificationCategories([Self.reminderCategory()])
        // A dead refresh token signs us out — drop any reminders for the old session.
        NotificationCenter.default.addObserver(forName: .waffledAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.clearPrincipalArtifacts() }
        }
        NotificationCenter.default.addObserver(forName: .waffledPrincipalIsolated, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.clearPrincipalArtifacts() }
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
        let context = PrincipalContext.current
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshAuthorization()
        if let context { await apply(for: context) }
        return granted
    }

    /// Set the app-icon badge (e.g. pending approvals a parent still owes). Silently
    /// no-ops if badge permission was denied — the in-app tab badge still shows.
    func setBadge(_ count: Int, for context: PrincipalContext) async {
        guard beginSystemMutation(for: context) else { return }
        defer { finishSystemMutation() }
        try? await center.setBadgeCount(max(0, count))
    }

    // MARK: reconcile

    /// Re-evaluate scheduled reminders from the latest synced events. Caches the
    /// inputs so a later preference change can reconcile on its own.
    func reconcile(
        events: [SyncedEvent],
        tz: TimeZone,
        myPersonId: String?,
        names: [String: String],
        for context: PrincipalContext
    ) async {
        guard context.isCurrent else { return }
        lastEvents = events; lastTz = tz; lastMyPersonId = myPersonId; lastNames = names
        await apply(for: context)
    }

    private func changed() {
        guard let context = PrincipalContext.current else { return }
        Task { await apply(for: context) }
    }

    private func apply(for context: PrincipalContext) async {
        guard beginSystemMutation(for: context) else { return }
        defer { finishSystemMutation() }

        // Off or not allowed → tear our reminders down and stop.
        guard enabled, authorization == .authorized || authorization == .provisional else {
            await clearEventReminders()
            droppedToCap = 0
            return
        }

        let now = Date()
        var planned: [(id: String, content: UNNotificationContent, fire: Date)] = []
        for e in lastEvents {
            if myEventsOnly, let mine = lastMyPersonId,
               !(e.personId == mine || e.participantIds.contains(mine)) { continue }
            guard let fire = fireDate(for: e), fire > now else { continue }
            planned.append((Self.idPrefix + e.id, content(for: e, context: context), fire))
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
        guard context.isCurrent else { return }
        let stale = existing.subtracting(desiredIds)
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: Array(stale)) }
        for p in keep {
            guard context.isCurrent else { return }
            // A one-shot time-interval trigger fires at the right absolute instant;
            // re-adding with the same id replaces, keeping reconcile idempotent.
            let interval = max(1, p.fire.timeIntervalSinceNow)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
            let req = UNNotificationRequest(identifier: p.id, content: p.content, trigger: trigger)
            await addSystemNotification(req)
            guard context.isCurrent else { return }
        }
    }

    // MARK: cook timers

    /// Schedule Cook Mode's out-of-app alarm through the same principal mutation
    /// barrier as event reminders, badges, and snoozes. The caller is synchronous so
    /// admission happens before it returns; cleanup can therefore see and drain the
    /// queued add even if UserNotifications has not started processing it yet.
    func scheduleCookTimer(
        id: String, fireAt: Date, name: String, link: CookTimerLink
    ) {
        let interval = fireAt.timeIntervalSinceNow
        guard interval > 0.5, let context = PrincipalContext.current else { return }

        let content = UNMutableNotificationContent()
        content.title = "Timer done"
        content.body = "\(name) — your cook timer is up."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = "waffled-cook-timers"
        var info = link.userInfo(timerId: id)
        context.stamp(&info)
        content.userInfo = info
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

        enqueueCookTimerSystemMutation(for: context) { [addSystemNotification] in
            await addSystemNotification(request)
        }
    }

    /// Remove both pending and already-delivered forms of a Cook Mode timer. This is
    /// queued behind an earlier add for the same session, so a quick pause/dismiss
    /// cannot have its remove overtaken by that add's asynchronous completion.
    func cancelCookTimer(_ id: String) {
        guard let context = PrincipalContext.current else { return }
        enqueueCookTimerSystemMutation(for: context) { [removeSystemNotifications] in
            await removeSystemNotifications([id])
        }
    }

    private func enqueueCookTimerSystemMutation(
        for context: PrincipalContext,
        _ operation: @escaping @MainActor () async -> Void
    ) {
        guard beginSystemMutation(for: context) else { return }
        let predecessor = cookTimerMutationTail
        let mutationID = UUID()
        let task = Task { @MainActor in
            if let predecessor { await predecessor.value }
            // Cleanup's final remove-all makes queued work redundant once admission is
            // frozen. Work already inside UserNotifications still completes and remains
            // counted until then, which is the race the drain is here to close.
            if !principalCleanupInProgress, context.isCurrent {
                await operation()
            }
            finishSystemMutation()
            if cookTimerMutationTailID == mutationID {
                cookTimerMutationTail = nil
                cookTimerMutationTailID = nil
            }
        }
        cookTimerMutationTail = task
        cookTimerMutationTailID = mutationID
    }

    /// Whether an identifier belongs to Calendar's auto-scheduled or snoozed reminders.
    /// Other features use their own `waffled.*` namespaces and must survive this cleanup.
    nonisolated static func isEventReminderIdentifier(_ identifier: String) -> Bool {
        identifier.hasPrefix(idPrefix) || identifier.hasPrefix(snoozePrefix)
    }

    /// Drop Calendar's auto-scheduled and snoozed reminders (e.g. on sign-out or when
    /// event reminders are disabled) without cancelling Cook Mode or future features.
    func clearEventReminders() async {
        let reqs = await center.pendingNotificationRequests()
        let ids = reqs.map(\.identifier).filter(Self.isEventReminderIdentifier)
        if !ids.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ids) }
    }

    /// Remove every principal-derived notification artifact. SyncManager awaits this
    /// at the successful replica-isolation boundary, before Session may expose login,
    /// a kiosk picker, or replacement credentials.
    func clearPrincipalArtifacts() async {
        if principalCleanupInProgress {
            await withCheckedContinuation { principalCleanupWaiters.append($0) }
            return
        }
        principalCleanupInProgress = true
        defer {
            principalCleanupInProgress = false
            let waiters = principalCleanupWaiters
            principalCleanupWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }

        lastEvents = []
        lastTz = .current
        lastMyPersonId = nil
        lastNames = [:]
        droppedToCap = 0
        pendingEventId = nil
        pendingCookTimer = nil

        // Freeze admission and drain already-running add/badge/snooze calls before the
        // final removal. Otherwise an operation suspended in UserNotifications can
        // complete after this method and recreate A's artifact under B's gate.
        await waitForSystemMutationsToDrain()
        await clearSystemPrincipalArtifacts()
    }

    private func beginSystemMutation(for context: PrincipalContext) -> Bool {
        guard !principalCleanupInProgress, context.isCurrent else { return false }
        activeSystemMutations += 1
        return true
    }

    private func finishSystemMutation() {
        activeSystemMutations -= 1
        guard activeSystemMutations == 0 else { return }
        let waiters = systemMutationDrainWaiters
        systemMutationDrainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func waitForSystemMutationsToDrain() async {
        guard activeSystemMutations > 0 else { return }
        await withCheckedContinuation { systemMutationDrainWaiters.append($0) }
    }

    /// Validate a delivered notification's embedded owner immediately before using
    /// its household identifiers. Missing markers from older builds fail closed.
    func contextForDeliveredNotification(
        _ info: [AnyHashable: Any]
    ) -> PrincipalContext? {
        guard !principalCleanupInProgress,
              let context = PrincipalContext.decode(info),
              context.isCurrent else { return nil }
        return context
    }

    func shouldPresentDeliveredNotification(_ info: [AnyHashable: Any]) -> Bool {
        contextForDeliveredNotification(info) != nil
    }

    func seedPrincipalArtifactsForTesting(eventId: String, cookTimer: CookTimerLink?) {
        pendingEventId = eventId
        pendingCookTimer = cookTimer
        lastMyPersonId = "person-a"
        lastNames = ["person-a": "A"]
    }

    var principalArtifactsAreEmptyForTesting: Bool {
        pendingEventId == nil && pendingCookTimer == nil && lastEvents.isEmpty &&
            lastMyPersonId == nil && lastNames.isEmpty && droppedToCap == 0
    }

    var principalCleanupInProgressForTesting: Bool { principalCleanupInProgress }

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

    private func content(
        for e: SyncedEvent,
        context: PrincipalContext
    ) -> UNNotificationContent {
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
        c.threadIdentifier = "waffled-events"
        c.categoryIdentifier = Self.categoryId
        var info: [String: Any] = ["eventId": e.id]
        context.stamp(&info)
        c.userInfo = info
        return c
    }

    /// Re-deliver a reminder `snoozeMinutes` from now (from the Snooze action). Reuses
    /// the original content under the snooze namespace so reconcile won't cancel it.
    func snooze(
        eventId: String,
        content: UNNotificationContent,
        context: PrincipalContext
    ) async {
        guard beginSystemMutation(for: context) else { return }
        defer { finishSystemMutation() }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval(Self.snoozeMinutes * 60), repeats: false)
        let req = UNNotificationRequest(identifier: Self.snoozePrefix + eventId, content: content, trigger: trigger)
        await addSystemNotification(req)
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
        Task { @MainActor in
            guard let manager,
                  let context = manager.contextForDeliveredNotification(content.userInfo) else {
                completionHandler()
                return
            }

            // Cook-mode timer taps carry a dish + step (+ its plate, no eventId) —
            // deep-link into Cook Mode. Checked first so a cook timer is never mistaken
            // for an event reminder.
            if let link = CookTimerLink.from(userInfo: content.userInfo) {
                manager.pendingCookTimer = link
                completionHandler()
                return
            }

            let id = content.userInfo["eventId"] as? String
            if response.actionIdentifier == "SNOOZE" {
                if let id {
                    await manager.snooze(eventId: id, content: content, context: context)
                }
            } else {
                // Default tap or the "View" action → deep-link to the event.
                manager.pendingEventId = id
            }
            completionHandler()
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let info = notification.request.content.userInfo
        Task { @MainActor in
            let options: UNNotificationPresentationOptions =
                manager?.shouldPresentDeliveredNotification(info) == true
                ? [.banner, .sound]
                : []
            completionHandler(options)
        }
    }
}
