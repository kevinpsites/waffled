import SwiftUI
import UIKit

/// The payload for a recipe share — a temp `.md` file URL, made Identifiable so it can
/// drive a `.sheet(item:)`.
struct RecipeSharePayload: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// Thin wrapper over `UIActivityViewController` — SwiftUI's `ShareLink` can't share an
/// item that's only ready after an async fetch, so we present the UIKit share sheet with
/// the already-written file. The sheet offers Messages / Mail / Save to Files / Copy, etc.
struct RecipeShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
