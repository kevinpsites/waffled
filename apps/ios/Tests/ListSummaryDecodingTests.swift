import Foundation
import Testing
@testable import Waffled

// `ListSummary` must decode BOTH server shapes for a list:
//
//  1. The index endpoints (GET /api/lists, GET /api/lists?type=template) attach a
//     live `itemCount` to each row.
//  2. Every mutate endpoint (POST /api/lists, POST /api/lists/apply-template,
//     save-as-template / unmark-template, PATCH /api/lists/:id) returns bare
//     `presentList(...)` JSON — id/name/emoji/listType/isAutoBuilt/sortMode,
//     **no `itemCount`** (apps/api lists.service.ts).
//
// A non-optional `itemCount` made shape 2 throw keyNotFound, which silently
// turned "create a list → open it" into a no-op fallback (create caught the
// decode error and returned nil), and likewise broke the save-as-template /
// use-template / capture create-list returns.
struct ListSummaryDecodingTests {
    /// Verbatim shape of a POST /api/lists reply body (`{ list: presentList(row) }`).
    private static let createResponse = Data("""
    {"list":{"id":"3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5","name":"Camping gear","emoji":"\u{26FA}","listType":"custom","isAutoBuilt":false,"sortMode":null}}
    """.utf8)

    /// One row of the GET /api/lists index reply (has `itemCount`).
    private static let indexRow = Data("""
    {"id":"3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5","name":"Camping gear","emoji":null,"listType":"custom","isAutoBuilt":false,"sortMode":null,"itemCount":7}
    """.utf8)

    @Test func decodesCreateResponseWithoutItemCount() throws {
        struct Resp: Decodable { let list: WaffledAPI.ListSummary }
        let created = try JSONDecoder().decode(Resp.self, from: Self.createResponse).list
        #expect(created.id == "3f6f0c1a-6f0e-4c2d-9d5a-b0a1c2d3e4f5")
        #expect(created.name == "Camping gear")
        #expect(created.listType == "custom")
        #expect(created.itemCount == 0)   // a brand-new list has no items yet
    }

    @Test func keepsItemCountFromIndexRows() throws {
        let row = try JSONDecoder().decode(WaffledAPI.ListSummary.self, from: Self.indexRow)
        #expect(row.itemCount == 7)
        #expect(row.emoji == nil)
    }
}
