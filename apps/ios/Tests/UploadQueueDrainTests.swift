import Foundation
import Testing
@testable import Waffled

/// Twin of the web `connector.test.ts` and Android `WaffledConnectorTest`: one transaction
/// the server refuses for good must not wedge every write queued behind it.
@MainActor
struct UploadQueueDrainTests {
    private final class FakeQueue {
        var pending: [String]
        var uploaded: [String] = []
        var failures: [String: Error] = [:]
        init(_ ids: String...) { pending = ids }

        func next() -> CrudUploadBatch? {
            guard let id = pending.first else { return nil }
            let op = CrudOpDTO(op: "PATCH", table: "events", id: id, data: ["title": id])
            return CrudUploadBatch(ops: [op]) { [self] in pending.removeFirst() }
        }

        func upload(_ ops: [CrudOpDTO]) throws {
            let id = ops[0].id
            if let error = failures.removeValue(forKey: id) { throw error }
            uploaded.append(id)
        }
    }

    /// Every api error body carries a JSON `error` code (the api's error sink).
    private static let apiBody = #"{"error":"BadRequest","message":"no"}"#

    private func drain(_ q: FakeQueue) async throws {
        try await UploadQueue.drain(next: { q.next() }, upload: { try q.upload($0) })
    }

    @Test func dropsAPermanentlyRejectedTransactionAndUploadsTheRest() async throws {
        let q = FakeQueue("bad", "good")
        q.failures["bad"] = WaffledAPI.APIError.http(400, Self.apiBody)
        try await drain(q)
        #expect(q.uploaded == ["good"])
        #expect(q.pending.isEmpty)
    }

    @Test(arguments: [403, 404, 409, 422])
    func treatsAFinal4xxAsPermanent(status: Int) async throws {
        let q = FakeQueue("bad")
        q.failures["bad"] = WaffledAPI.APIError.http(status, Self.apiBody)
        try await drain(q)
        #expect(q.pending.isEmpty)
    }

    @Test(arguments: [401, 408, 429, 500, 503])
    func keepsTheQueueOnARetryableStatus(status: Int) async {
        let q = FakeQueue("a", "b")
        q.failures["a"] = WaffledAPI.APIError.http(status, Self.apiBody)
        await #expect(throws: WaffledAPI.APIError.self) { try await drain(q) }
        #expect(q.pending == ["a", "b"])
        #expect(q.uploaded.isEmpty)
    }

    /// A proxy or stale route answering 404 with a page is not the api's verdict.
    @Test(arguments: ["<html>Not Found</html>", "", #"{"message":"x"}"#])
    func keepsTheQueueOnA4xxTheApiDidNotSend(body: String) async {
        let q = FakeQueue("a")
        q.failures["a"] = WaffledAPI.APIError.http(404, body)
        await #expect(throws: WaffledAPI.APIError.self) { try await drain(q) }
        #expect(q.pending == ["a"])
    }

    @Test func keepsTheQueueWhenTheServerNeverAnswered() async {
        let q = FakeQueue("a")
        q.failures["a"] = URLError(.notConnectedToInternet)
        await #expect(throws: URLError.self) { try await drain(q) }
        #expect(q.pending == ["a"])
    }
}
