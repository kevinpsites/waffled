import Foundation
import Testing
@testable import Waffled

// Ordering rules for a day's chores (ChoresModel.sortChores):
//   1. incomplete (status == "pending") first — done/awaiting sink
//   2. then due time ascending, with a set "HH:mm" before an unset (nil) time
//   3. then title A–Z (case-insensitive)
// The DTO only has a Decodable init, so build fixtures by decoding minimal JSON.

private func inst(_ title: String, status: String = "pending", dueTime: String? = nil)
    -> WaffledAPI.ChoreInstanceDTO {
    var obj: [String: Any] = [
        "id": "id-\(title)-\(status)-\(dueTime ?? "nil")",
        "choreId": "c-\(title)",
        "choreTitle": title,
        "status": status,
        "rewardAmount": 0,
        "requiresApproval": false,
        "requiresPhoto": false,
        "streak": 0,
    ]
    if let dueTime { obj["dueTime"] = dueTime }
    let data = try! JSONSerialization.data(withJSONObject: obj)
    return try! JSONDecoder().decode(WaffledAPI.ChoreInstanceDTO.self, from: data)
}

private func titles(_ xs: [WaffledAPI.ChoreInstanceDTO]) -> [String] { xs.map(\.choreTitle) }

@Suite struct ChoreSortTests {
    @Test func incompleteBeforeCompletedAndAwaiting() {
        let sorted = ChoresModel.sortChores([
            inst("Done thing", status: "done"),
            inst("Awaiting thing", status: "awaiting"),
            inst("Pending thing", status: "pending"),
        ])
        // The single pending one leads; the two non-pending ones sink (relative order
        // among them is then decided by title A–Z).
        #expect(titles(sorted) == ["Pending thing", "Awaiting thing", "Done thing"])
    }

    @Test func dueTimeAscendingThenUntimedLast() {
        let sorted = ChoresModel.sortChores([
            inst("No time"),
            inst("Evening", dueTime: "18:00"),
            inst("Morning", dueTime: "07:30"),
        ])
        #expect(titles(sorted) == ["Morning", "Evening", "No time"])
    }

    @Test func titleTiebreakCaseInsensitive() {
        let sorted = ChoresModel.sortChores([
            inst("banana"),
            inst("Apple"),
            inst("cherry"),
        ])
        #expect(titles(sorted) == ["Apple", "banana", "cherry"])
    }

    @Test func awaitingWithEarlierTimeStillSinksBelowPending() {
        // Status trumps time: an awaiting chore due at 06:00 must NOT jump above a pending
        // one with no time at all.
        let sorted = ChoresModel.sortChores([
            inst("Early awaiting", status: "awaiting", dueTime: "06:00"),
            inst("Untimed pending"),
        ])
        #expect(titles(sorted) == ["Untimed pending", "Early awaiting"])
    }

    @Test func equalTimeAndTitleAreEquivalent() {
        // Same status, same dueTime, same title → the comparator reports neither strictly
        // before the other (a proper strict-weak ordering).
        let a = inst("Tidy up", dueTime: "08:00")
        let b = inst("Tidy up", dueTime: "08:00")
        #expect(ChoresModel.choreSortsBefore(a, b) == false)
        #expect(ChoresModel.choreSortsBefore(b, a) == false)
    }

    @Test func fullOrderingAcrossAllRules() {
        let sorted = ChoresModel.sortChores([
            inst("Zebra done", status: "done"),
            inst("Alpha done", status: "done", dueTime: "06:00"),
            inst("Untimed pending"),
            inst("Nine pending", dueTime: "09:00"),
            inst("Eight pending", dueTime: "08:00"),
            inst("Also eight", dueTime: "08:00"),
        ])
        // Pending group first: 08:00 pair (title A–Z), then 09:00, then untimed;
        // then the done group sinks (its earlier due time does NOT lift it above pending).
        #expect(titles(sorted) == [
            "Also eight", "Eight pending", "Nine pending", "Untimed pending",
            "Alpha done", "Zebra done",
        ])
    }
}
