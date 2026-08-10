import Testing
@testable import Waffled

@Suite struct NotificationIdentifierTests {
    @Test func eventReminderCleanupOwnsOnlyEventNamespaces() {
        #expect(NotificationManager.isEventReminderIdentifier("waffled.evt.event-1"))
        #expect(NotificationManager.isEventReminderIdentifier("waffled.snz.event-1"))

        #expect(!NotificationManager.isEventReminderIdentifier("waffled.cook.timer-1"))
        #expect(!NotificationManager.isEventReminderIdentifier("waffled.some-future-feature"))
        #expect(!NotificationManager.isEventReminderIdentifier("another-app.event-1"))
    }
}
