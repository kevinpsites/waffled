import SwiftUI

/// Mint a one-time code and wait for the physical Waffled-Bite to claim it — mirrors
/// `apps/web/src/kiosk/components/WaffledBitePairModal.tsx` exactly: no client-side
/// timeout, polling continues until the device shows up or this sheet is dismissed
/// (the server's 10-minute code TTL is the only real limit, never surfaced here either).
struct WaffledBitePairSheet: View {
    @Environment(\.dismiss) private var dismiss
    let personId: String
    let personName: String
    let onPaired: () -> Void

    @State private var code: String?
    @State private var mintFailed = false
    @State private var pollTask: Task<Void, Never>?

    private let api = WaffledAPI()

    var body: some View {
        VStack(spacing: 24) {
            Text("🧇").font(.system(size: 44))

            if mintFailed {
                Text("Couldn't start pairing — try again.")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.danger)
            } else if let code {
                VStack(spacing: 14) {
                    Text(code)
                        .font(.system(size: 40, weight: .heavy, design: .monospaced))
                        .tracking(6)
                        .foregroundStyle(WF.ink)
                    Text("Waiting for the Waffled-Bite…")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                    ProgressView().tint(WF.ink3)
                }
            } else {
                ProgressView().tint(WF.ink3)
                Text("Generating a code…").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            }

            Button("Cancel") { dismiss() }
                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
        }
        .padding(28)
        .presentationDetents([.medium])
        .task { await mintAndPoll() }
        .onDisappear { pollTask?.cancel() }
    }

    private func mintAndPoll() async {
        do {
            let minted = try await api.mintWaffledBitePairingCode(personId: personId, label: "\(personName)'s Waffled-Bite")
            code = minted.code
        } catch {
            mintFailed = true
            return
        }
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                if (try? await api.waffledBiteDevice(personId: personId)) != nil {
                    onPaired()
                    return
                }
            }
        }
    }
}
