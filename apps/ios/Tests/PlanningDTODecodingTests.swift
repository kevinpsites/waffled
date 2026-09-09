import Foundation
import Testing
@testable import Waffled

// Weekly Planning's wire types, decoded from payload bytes shaped like the server's.
//
// `WaffledAPI.decoder` is a plain `JSONDecoder` — no key strategy, no date strategy —
// so every property name here has to be camelCase 1:1 with the server and every
// timestamp has to stay a `String`. A rename on either side is invisible to the
// compiler and shows up as a silently nil field or a screen that will not load; this is
// the only place it is checked.
//
// The load-bearing cases are the ABSENT keys: `parked` is missing from a payload served
// by an older build, and `requiresModule` is absent on five of the ten steps.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try WaffledAPI.decoder.decode(type, from: Data(json.utf8))
}

@Suite struct PlanningDTODecodingTests {

    @Test func decodesTheFullView() throws {
        let view = try decode(WaffledAPI.WeeklyPlanningView.self, """
        {
          "config": { "dayOfWeek": 0, "time": "17:00", "steps": { "horizon": false }, "showOnToday": true },
          "weekStart": "2026-09-06",
          "defaultWeekStart": "2026-09-06",
          "minWeekStart": "2026-08-30",
          "session": {
            "id": "3f1c6d54-0f7a-4a3e-9a1d-2c5b7e8f0a11",
            "weekStart": "2026-09-06",
            "status": "active",
            "currentStep": "calendar",
            "driverPersonId": "8b2e1a90-11c4-4c1e-8c7a-5d3f9b0e2a44",
            "startedAt": "2026-09-06T17:00:03.412Z",
            "completedAt": null
          },
          "steps": [
            {
              "key": "looseEnds", "number": 1, "title": "Loose ends",
              "ask": "Anything still open from last week?", "primary": "All handled",
              "act": "Intake", "available": true, "status": "done",
              "data": { "cleared": 4, "parked": true },
              "decidedAt": "2026-09-06T17:02:11.008Z",
              "parked": []
            },
            {
              "key": "calendar", "number": 2, "title": "Calendar",
              "ask": "Here’s your week. Anything missing?", "primary": "Looks right",
              "act": "Frame the week", "available": true, "status": "pending",
              "data": {}, "decidedAt": null,
              "parked": [
                { "id": "c0ffee00-0000-4000-8000-000000000001", "note": "Book the dentist", "byline": "Kevin · 2 weeks ago" },
                { "id": "c0ffee00-0000-4000-8000-000000000002", "note": "Swim lessons start", "byline": null }
              ]
            },
            {
              "key": "meals", "number": 7, "title": "Meals",
              "ask": "What’s planned, and what’s still open?", "primary": "Done",
              "act": "Run the household", "requiresModule": "meals",
              "available": false, "status": "pending",
              "data": {}, "decidedAt": null, "parked": []
            }
          ]
        }
        """)

        #expect(view.weekStart == "2026-09-06")
        #expect(view.minWeekStart == "2026-08-30")
        #expect(view.config.dayOfWeek == 0)
        #expect(view.config.time == "17:00")
        #expect(view.config.steps["horizon"] == false)
        #expect(view.config.showOnToday)

        let session = try #require(view.session)
        #expect(session.isActive)
        #expect(session.currentStep == "calendar")
        #expect(session.completedAt == nil)
        // Timestamps stay strings — there is no date strategy on the shared decoder.
        #expect(session.startedAt == "2026-09-06T17:00:03.412Z")

        #expect(view.steps.count == 3)
        let looseEnds = view.steps[0]
        #expect(looseEnds.isDone)
        #expect(looseEnds.isSettled)
        #expect(looseEnds.requiresModule == nil)
        #expect(looseEnds.data["cleared"] == JSONValue.int(4))
        #expect(looseEnds.data["parked"] == JSONValue.bool(true))

        let calendar = view.steps[1]
        #expect((calendar.parked ?? []).count == 2)
        #expect(calendar.parked?.first?.note == "Book the dentist")
        #expect(calendar.parked?.first?.byline == "Kevin · 2 weeks ago")
        #expect(calendar.parked?.last?.byline == nil)

        let meals = view.steps[2]
        #expect(meals.requiresModule == "meals")
        #expect(!meals.available)

        #expect(PlanningFormat.availableSteps(view.steps).map(\.key) == ["looseEnds", "calendar"])
        #expect(PlanningFormat.resolveCurrent(view)?.key == "calendar")
        #expect(PlanningFormat.settledFraction(view.steps) == 0.5)
    }

    @Test func aStepWithNoParkedKeyStillDecodes() throws {
        // A server that predates the handoff banner sends no `parked` at all. It must
        // cost the banner, never the screen — hence the optional field and `?? []`.
        let step = try decode(WaffledAPI.PlanningStep.self, """
        {
          "key": "kids", "number": 9, "title": "Kids", "ask": "What’s your week about?",
          "primary": "Done", "act": "Run the household",
          "available": true, "status": "pending", "data": {}, "decidedAt": null
        }
        """)

        #expect(step.parked == nil)
        #expect((step.parked ?? []).isEmpty)
        #expect(step.requiresModule == nil)
        #expect(!step.isSettled)
    }

    @Test func aSkippedStepIsSettledButNotDone() throws {
        let step = try decode(WaffledAPI.PlanningStep.self, """
        {
          "key": "horizon", "number": 3, "title": "Horizon scan",
          "ask": "Anything further out you should see now?", "primary": "Nothing missing",
          "act": "Frame the week", "available": true, "status": "skipped",
          "data": {}, "decidedAt": "2026-09-06T17:09:44.100Z", "parked": []
        }
        """)

        #expect(step.isSkipped)
        #expect(step.isSettled)
        #expect(!step.isDone)
    }

    @Test func decodesAViewWithNoSessionYet() throws {
        let view = try decode(WaffledAPI.WeeklyPlanningView.self, """
        {
          "config": { "dayOfWeek": 4, "time": "18:30", "steps": {}, "showOnToday": false },
          "weekStart": "2026-09-13",
          "defaultWeekStart": "2026-09-13",
          "minWeekStart": "2026-09-06",
          "session": null,
          "steps": []
        }
        """)

        #expect(view.session == nil)
        #expect(!view.config.showOnToday)
        #expect(view.config.steps.isEmpty)
        #expect(PlanningFormat.resolveCurrent(view) == nil)
        #expect(PlanningFormat.settledFraction(view.steps) == 0)
    }

    @Test func decodesTheCompletedSessionEnvelope() throws {
        let done = try decode(WaffledAPI.WeeklyPlanningCompletion.self, """
        {
          "session": {
            "id": "3f1c6d54-0f7a-4a3e-9a1d-2c5b7e8f0a11",
            "weekStart": "2026-09-06",
            "status": "completed",
            "currentStep": "recap",
            "driverPersonId": null,
            "startedAt": "2026-09-06T17:00:03.412Z",
            "completedAt": "2026-09-06T17:32:58.771Z"
          },
          "steps": []
        }
        """)

        #expect(done.session.isCompleted)
        #expect(!done.session.isActive)
        #expect(done.session.completedAt == "2026-09-06T17:32:58.771Z")
    }

    @Test func decodesTheBareConfigCatalog() throws {
        // `GET /api/weekly-planning/config` returns the raw `STEPS` array — no
        // `available`, `status`, `number`, `data`, `decidedAt` or `parked`. Decoding it
        // as a `PlanningStep` would fail outright, which is why it has its own type.
        let payload = try decode(WaffledAPI.WeeklyPlanningConfigView.self, """
        {
          "config": { "dayOfWeek": 0, "time": "17:00", "steps": {}, "showOnToday": true },
          "steps": [
            { "key": "looseEnds", "title": "Loose ends", "ask": "Anything still open from last week?", "primary": "All handled", "act": "Intake" },
            { "key": "tasks", "title": "Tasks", "ask": "Who’s doing what?", "primary": "Handed out", "act": "Run the household", "requiresModule": "chores" }
          ]
        }
        """)

        #expect(payload.steps.count == 2)
        #expect(payload.steps[0].requiresModule == nil)
        #expect(payload.steps[1].requiresModule == "chores")
        #expect(payload.steps[1].primary == "Handed out")
    }

    // MARK: - The label the record's byline shows

    @MainActor
    @Test func aTimestampWithNoFractionStillFormats() {
        // Postgres `to_json` on a timestamp can drop the milliseconds; both shapes have
        // to parse, and an unparseable one must fall back to the raw string rather than
        // blanking the byline.
        #expect(PlanningModel.savedLabel("2026-09-06T17:32:58Z") != "2026-09-06T17:32:58Z")
        #expect(PlanningModel.savedLabel("2026-09-06T17:32:58.771Z") != "2026-09-06T17:32:58.771Z")
        #expect(PlanningModel.savedLabel("not a timestamp") == "not a timestamp")
    }
}
