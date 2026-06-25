import SwiftUI

/// The admin's "stored chore photos" manager, opened from Chores & Rewards settings.
/// A grid of currently-retained proof photos — tap one to view it big, delete one, or
/// clear them all. Mirrors the web `ChoreProofsDrawer`. Deletes hit the API directly and
/// update the local list, then tell the caller to refresh its count.
struct StoredProofsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var proofs: [NookAPI.StoredProof]
    @State private var enlarged: NookAPI.StoredProof?
    @State private var confirmClear = false
    @State private var busy = false
    let onChanged: () async -> Void

    private let api = NookAPI()
    private let cols = [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)]

    init(proofs: [NookAPI.StoredProof], onChanged: @escaping () async -> Void) {
        _proofs = State(initialValue: proofs)
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if proofs.isEmpty {
                    NookEmptyState(emoji: "🗂️", title: "No stored photos",
                                   message: "Chore proof photos appear here while they’re kept.", top: 48)
                } else {
                    LazyVGrid(columns: cols, spacing: 12) {
                        ForEach(proofs) { cell($0) }
                    }
                    .padding(16).padding(.bottom, 110)
                }
            }
            .background(NK.canvas)
            .navigationTitle("Stored photos").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if !proofs.isEmpty {
                        Button("Clear all") { confirmClear = true }
                            .foregroundStyle(NK.primary).disabled(busy)
                    }
                }
            }
            .confirmationDialog("Delete all \(proofs.count) stored photos?",
                                isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Delete all", role: .destructive) { clearAll() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $enlarged) { enlargedView($0) }
        }
    }

    private func cell(_ p: NookAPI.StoredProof) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { enlarged = p } label: {
                AsyncImage(url: MediaURL.resolve(p.proofUrl)) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() }
                    else { ZStack { NK.panel; ProgressView() } }
                }
                .frame(height: 128).frame(maxWidth: .infinity).clipped()
            }
            .buttonStyle(.plain)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(p.emoji ?? "🧹") \(p.choreTitle)")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                    Text([p.personName, Self.shortDate(p.completedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 11.5)).foregroundStyle(NK.ink3).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button { deleteOne(p) } label: {
                    Image(systemName: "trash").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.primary)
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain).disabled(busy)
            }
            .padding(10)
        }
        .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }

    private func enlargedView(_ p: NookAPI.StoredProof) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    AsyncImage(url: MediaURL.resolve(p.proofUrl)) { phase in
                        if let img = phase.image { img.resizable().scaledToFit() }
                        else { ZStack { NK.panel; ProgressView() }.frame(height: 240) }
                    }
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    Text("\(p.emoji ?? "🧹") \(p.choreTitle)")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                        .multilineTextAlignment(.center)
                    Text([p.personName, Self.shortDate(p.completedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 13)).foregroundStyle(NK.ink3)
                    Button { deleteOne(p); enlarged = nil } label: {
                        Text("Delete this photo").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.primary)
                    }
                    .buttonStyle(.plain).padding(.top, 4)
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("Photo").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { enlarged = nil } } }
        }
        .presentationDetents([.large])
    }

    // MARK: actions

    private func deleteOne(_ p: NookAPI.StoredProof) {
        Task {
            try? await api.deleteProof(instanceId: p.instanceId)
            proofs.removeAll { $0.id == p.id }
            await onChanged()
        }
    }

    private func clearAll() {
        busy = true
        Task {
            _ = try? await api.clearProofs()
            proofs = []
            await onChanged()
            busy = false
        }
    }

    // ISO8601 (with fractional seconds) → "MMM d"; nil if it won't parse.
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static func shortDate(_ s: String?) -> String? {
        guard let s, let d = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s) else { return nil }
        let f = DateFormatter(); f.dateFormat = "MMM d"
        return f.string(from: d)
    }
}
