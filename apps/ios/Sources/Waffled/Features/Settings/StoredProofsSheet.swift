import Observation
import SwiftUI

@MainActor
@Observable
final class StoredProofsModel {
    typealias DeleteProof = (String) async throws -> Void
    typealias ClearProofs = () async throws -> Int
    typealias OnChanged = () async -> Void

    private(set) var proofs: [WaffledAPI.StoredProof]
    private(set) var busy = false
    private(set) var errorMessage: String?

    private let deleteProof: DeleteProof
    private let clearProofs: ClearProofs
    private let onChanged: OnChanged

    init(
        proofs: [WaffledAPI.StoredProof],
        deleteProof: @escaping DeleteProof,
        clearProofs: @escaping ClearProofs,
        onChanged: @escaping OnChanged
    ) {
        self.proofs = proofs
        self.deleteProof = deleteProof
        self.clearProofs = clearProofs
        self.onChanged = onChanged
    }

    @discardableResult
    func delete(_ proof: WaffledAPI.StoredProof) async -> Bool {
        guard !busy else { return false }
        busy = true
        errorMessage = nil
        defer { busy = false }

        do {
            try await deleteProof(proof.instanceId)
            proofs.removeAll { $0.id == proof.id }
            await onChanged()
            return true
        } catch {
            errorMessage = "Couldn’t delete this photo. Check your connection and try again."
            return false
        }
    }

    @discardableResult
    func clearAll() async -> Bool {
        guard !busy else { return false }
        busy = true
        errorMessage = nil
        defer { busy = false }

        do {
            _ = try await clearProofs()
            proofs = []
            await onChanged()
            return true
        } catch {
            errorMessage = "Couldn’t clear stored photos. Check your connection and try again."
            return false
        }
    }

    func dismissError() {
        errorMessage = nil
    }
}

/// The admin's "stored chore photos" manager, opened from Chores & Rewards settings.
/// A grid of currently-retained proof photos — tap one to view it big, delete one, or
/// clear them all. Mirrors the web `ChoreProofsDrawer`. Confirmed deletes update the local
/// list, then tell the caller to refresh its count; failures leave the visible rows intact.
struct StoredProofsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: StoredProofsModel
    @State private var enlarged: WaffledAPI.StoredProof?
    @State private var confirmClear = false

    private let cols = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)]

    init(proofs: [WaffledAPI.StoredProof], onChanged: @escaping () async -> Void) {
        let api = WaffledAPI()
        _model = State(initialValue: StoredProofsModel(
            proofs: proofs,
            deleteProof: { try await api.deleteProof(instanceId: $0) },
            clearProofs: { try await api.clearProofs() },
            onChanged: onChanged))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if model.proofs.isEmpty {
                    WaffledEmptyState(emoji: "🗂️", title: "No stored photos",
                                   message: "Chore proof photos appear here while they’re kept.", top: 48)
                } else {
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(model.proofs) { cell($0) }
                    }
                    .padding(16).padding(.bottom, 110)
                }
            }
            .background(WF.canvas)
            .navigationTitle("Stored photos").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if !model.proofs.isEmpty {
                        Button("Clear all") { confirmClear = true }
                            .foregroundStyle(WF.primary).disabled(model.busy)
                    }
                }
            }
            .confirmationDialog("Delete all \(model.proofs.count) stored photos?",
                                isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Delete all", role: .destructive) { clearAll() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $enlarged) { enlargedView($0) }
            .alert("Photos unchanged", isPresented: errorPresented) {
                Button("OK") { model.dismissError() }
            } message: {
                Text(model.errorMessage ?? "The photos could not be changed.")
            }
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.dismissError() } })
    }

    private func cell(_ p: WaffledAPI.StoredProof) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { enlarged = p } label: {
                // Image in an overlay over a sized spacer so scaledToFill can't inflate
                // the cell's layout width (which otherwise pushes cells past the sheet).
                Color.clear
                    .frame(height: 128).frame(maxWidth: .infinity)
                    .overlay {
                        AsyncImage(url: MediaURL.resolve(p.proofUrl)) { phase in
                            if let img = phase.image { img.resizable().scaledToFill() }
                            else { ZStack { WF.panel; ProgressView() } }
                        }
                    }
                    .clipped()
            }
            .buttonStyle(.plain)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(p.emoji ?? "🧹") \(p.choreTitle)")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                    Text([p.personName, Self.shortDate(p.completedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 11.5)).foregroundStyle(WF.ink3).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button { deleteOne(p) } label: {
                    Image(systemName: "trash").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primary)
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain).disabled(model.busy)
            }
            .padding(10)
        }
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func enlargedView(_ p: WaffledAPI.StoredProof) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    AsyncImage(url: MediaURL.resolve(p.proofUrl)) { phase in
                        if let img = phase.image { img.resizable().scaledToFit() }
                        else { ZStack { WF.panel; ProgressView() }.frame(height: 240) }
                    }
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    Text("\(p.emoji ?? "🧹") \(p.choreTitle)")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                        .multilineTextAlignment(.center)
                    Text([p.personName, Self.shortDate(p.completedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 13)).foregroundStyle(WF.ink3)
                    Button { deleteOne(p, closeAfterDelete: true) } label: {
                        Text("Delete this photo").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.primary)
                    }
                    .buttonStyle(.plain).padding(.top, 4).disabled(model.busy)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Photo").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { enlarged = nil } } }
        }
        .presentationDetents([.large])
    }

    // MARK: actions

    private func deleteOne(_ p: WaffledAPI.StoredProof, closeAfterDelete: Bool = false) {
        Task {
            if await model.delete(p), closeAfterDelete {
                enlarged = nil
            }
        }
    }

    private func clearAll() {
        Task {
            await model.clearAll()
        }
    }

    // ISO8601 (with fractional seconds) → "MMM d"; nil if it won't parse.
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    // Fallback parser for strings without fractional seconds (plain internet date-time).
    private static let isoPlain = ISO8601DateFormatter()
    private static let shortDateFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f
    }()
    private static func shortDate(_ s: String?) -> String? {
        guard let s, let d = iso.date(from: s) ?? isoPlain.date(from: s) else { return nil }
        return shortDateFmt.string(from: d)
    }
}
