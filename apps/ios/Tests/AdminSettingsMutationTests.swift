import Testing
@testable import Waffled

private enum AdminSettingsFailure: Error {
    case rejected
}

private func familyNightConfig(
    day: Int = 1,
    time: String = "19:00",
    eventId: String? = nil,
    label: String = "Activity"
) -> WaffledAPI.FamilyNightConfig {
    .init(
        parts: [.init(id: "activity", label: label, emoji: "🎲", rotates: true)],
        dayOfWeek: day,
        time: time,
        rotationOrder: nil,
        eventId: eventId
    )
}

private func familyNightView(_ config: WaffledAPI.FamilyNightConfig) -> WaffledAPI.FamilyNightView {
    .init(
        config: config,
        members: [],
        next: .init(
            date: "2026-08-03",
            occurrenceId: nil,
            theme: nil,
            notes: nil,
            status: "planned",
            assignments: []
        )
    )
}

@MainActor
@Suite struct AdminSettingsMutationTests {
    @Test func failedCountdownPreferenceRollsBackOptimisticControl() async {
        let model = CountdownSettingsModel(
            fetch: { (false, 183) },
            setSleeps: { _ in throw AdminSettingsFailure.rejected },
            setHorizon: { _ in }
        )
        await model.load()

        await model.changeSleeps(to: true)

        #expect(!model.sleeps)
        #expect(model.errorMessage != nil)
    }

    @Test func failedCountdownHorizonKeepsConfirmedValue() async {
        let model = CountdownSettingsModel(
            fetch: { (false, 183) },
            setSleeps: { _ in },
            setHorizon: { _ in throw AdminSettingsFailure.rejected }
        )
        await model.load()

        await model.changeHorizon(to: 366)

        #expect(model.birthdayHorizon == 183)
        #expect(model.errorMessage != nil)
    }

    @Test func failedFamilyNightScheduleRollsBackDayAndTime() async {
        let original = familyNightConfig(day: 1, time: "19:00")
        let model = FamilyNightSettingsModel(
            fetch: { familyNightView(original) },
            setConfig: { _ in throw AdminSettingsFailure.rejected },
            schedule: { "event-1" },
            unschedule: {}
        )
        await model.load()

        await model.setDay(5)

        #expect(model.dayOfWeek == 1)
        #expect(model.time == "19:00")
        #expect(model.errorMessage?.contains("wasn’t saved") == true)
    }

    @Test func failedCalendarRefreshKeepsTheConfirmedNewSchedule() async {
        let original = familyNightConfig(day: 1, time: "19:00", eventId: "event-1")
        let model = FamilyNightSettingsModel(
            fetch: { familyNightView(original) },
            setConfig: { _ in familyNightConfig(day: 5, time: "19:00", eventId: "event-1") },
            schedule: { throw AdminSettingsFailure.rejected },
            unschedule: {}
        )
        await model.load()

        await model.setDay(5)

        #expect(model.dayOfWeek == 5)
        #expect(model.errorMessage?.contains("was saved") == true)
        #expect(model.errorMessage?.contains("calendar event") == true)
    }

    @Test func failedFamilyNightCalendarToggleRollsBack() async {
        let original = familyNightConfig(eventId: nil)
        let model = FamilyNightSettingsModel(
            fetch: { familyNightView(original) },
            setConfig: { _ in original },
            schedule: { throw AdminSettingsFailure.rejected },
            unschedule: {}
        )
        await model.load()

        await model.setCalendar(true)

        #expect(!model.onCalendar)
        #expect(model.errorMessage != nil)
    }

    @Test func failedAgendaSavePreservesTheDraftForRetry() async {
        let original = familyNightConfig(label: "Activity")
        let model = FamilyNightSettingsModel(
            fetch: { familyNightView(original) },
            setConfig: { _ in throw AdminSettingsFailure.rejected },
            schedule: { "event-1" },
            unschedule: {}
        )
        await model.load()
        model.parts[0].label = "Board game"

        await model.saveAgenda()

        #expect(model.parts[0].label == "Board game")
        #expect(model.errorMessage?.contains("edits are still here") == true)
    }
}

@MainActor
@Suite struct EventDeletionPolicyTests {
    @Test func rejectedRecurringDeleteIsNotReportedAsSuccess() async {
        let deleted = await EventDeletionPolicy.perform(
            isRecurring: true,
            deleteRecurring: { throw AdminSettingsFailure.rejected },
            deleteSingle: { true }
        )

        #expect(!deleted)
    }

    @Test func rejectedLocalDeleteIsNotReportedAsSuccess() async {
        let deleted = await EventDeletionPolicy.perform(
            isRecurring: false,
            deleteRecurring: {},
            deleteSingle: { false }
        )

        #expect(!deleted)
    }

    @Test func confirmedDeleteIsReportedAsSuccess() async {
        let deleted = await EventDeletionPolicy.perform(
            isRecurring: true,
            deleteRecurring: {},
            deleteSingle: { false }
        )

        #expect(deleted)
    }
}
