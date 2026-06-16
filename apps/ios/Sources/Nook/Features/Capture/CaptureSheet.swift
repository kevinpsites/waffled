import SwiftUI

/// The "Add anything" capture sheet, opened by the center ✨ tab button.
/// Phase 0 shows the entry UI; Phase 2 wires it to `POST /api/capture` and the
/// "Nook understood" parse preview from the handoff `ios-add.png`.
struct CaptureSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").font(.system(size: 15, weight: .bold))
                    .foregroundStyle(NK.ai)
                Text("Add with AI").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ai)
                Spacer()
                Button("Cancel") { dismiss() }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(NK.ink2)
            }

            TextField("Soccer practice every Tuesday at 4pm for Wally…",
                      text: $text, axis: .vertical)
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(3...6)
                .padding(16)
                .background(NK.panel)
                .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))

            Text("Parsing wires up in Phase 2 (POST /api/capture).")
                .font(.system(size: 13)).foregroundStyle(NK.ink3)

            Spacer()
        }
        .padding(20)
        .background(NK.canvas)
        .presentationDetents([.medium, .large])
    }
}

#Preview { CaptureSheet() }
