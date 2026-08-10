import Foundation
import Testing
@testable import Waffled

private enum ProofMutationFailure: Error {
    case offline
}

@MainActor
private final class ChangeRecorder {
    var count = 0

    func record() {
        count += 1
    }
}

private func proof(_ id: String) -> WaffledAPI.StoredProof {
    WaffledAPI.StoredProof(
        instanceId: id,
        choreTitle: "Put away dishes",
        emoji: "dishwasher",
        personName: "Avery",
        personAvatar: nil,
        personColor: nil,
        proofUrl: "/media/proofs/\(id).jpg",
        completedAt: "2026-07-25T12:00:00.000Z")
}

@MainActor
@Suite struct StoredProofsModelTests {
    @Test func failedSingleDeleteKeepsProofAndReportsFailure() async {
        let item = proof("proof-1")
        let changes = ChangeRecorder()
        let model = StoredProofsModel(
            proofs: [item],
            deleteProof: { _ in throw ProofMutationFailure.offline },
            clearProofs: { 0 },
            onChanged: { changes.record() })

        let deleted = await model.delete(item)

        #expect(!deleted)
        #expect(model.proofs.map(\.id) == ["proof-1"])
        #expect(model.errorMessage == "Couldn’t delete this photo. Check your connection and try again.")
        #expect(!model.busy)
        #expect(changes.count == 0)
    }

    @Test func successfulSingleDeleteRemovesProofAndNotifiesParent() async {
        let first = proof("proof-1")
        let second = proof("proof-2")
        let changes = ChangeRecorder()
        var deletedIDs: [String] = []
        let model = StoredProofsModel(
            proofs: [first, second],
            deleteProof: { deletedIDs.append($0) },
            clearProofs: { 0 },
            onChanged: { changes.record() })

        let deleted = await model.delete(first)

        #expect(deleted)
        #expect(deletedIDs == ["proof-1"])
        #expect(model.proofs.map(\.id) == ["proof-2"])
        #expect(model.errorMessage == nil)
        #expect(changes.count == 1)
    }

    @Test func failedClearAllKeepsProofsAndReportsFailure() async {
        let changes = ChangeRecorder()
        let model = StoredProofsModel(
            proofs: [proof("proof-1"), proof("proof-2")],
            deleteProof: { _ in },
            clearProofs: { throw ProofMutationFailure.offline },
            onChanged: { changes.record() })

        let cleared = await model.clearAll()

        #expect(!cleared)
        #expect(model.proofs.map(\.id) == ["proof-1", "proof-2"])
        #expect(model.errorMessage == "Couldn’t clear stored photos. Check your connection and try again.")
        #expect(!model.busy)
        #expect(changes.count == 0)
    }

    @Test func successfulClearAllRemovesProofsAndNotifiesParent() async {
        let changes = ChangeRecorder()
        var clearCount = 0
        let model = StoredProofsModel(
            proofs: [proof("proof-1"), proof("proof-2")],
            deleteProof: { _ in },
            clearProofs: {
                clearCount += 1
                return 2
            },
            onChanged: { changes.record() })

        let cleared = await model.clearAll()

        #expect(cleared)
        #expect(clearCount == 1)
        #expect(model.proofs.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(changes.count == 1)
    }
}
