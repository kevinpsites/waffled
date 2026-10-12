import SwiftUI

/// Import from Google Photos into one album. Google's picker opens outside the app
/// (the Google Photos app when installed, otherwise Safari); this sheet polls the
/// import until the server has copied the picked photos in. Mirrors web
/// `GooglePhotosImportModal.tsx`.
struct GooglePhotosImportSheet: View {
    var albums: [String] = []
    /// Pre-fills the album, for a re-sync.
    var initialAlbum: String = ""
    var onImported: (_ album: String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var album = ""
    @State private var seeded = false
    @State private var current: WaffledAPI.GooglePhotosImport?
    @State private var busy = false
    @State private var errorText: String?

    private let api = WaffledAPI()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let imp = current {
                        Text(Self.message(for: imp))
                            .font(.system(size: 15, weight: .medium)).foregroundStyle(WF.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if imp.status == "picking", let url = URL(string: imp.pickerUri) {
                            Button("Reopen Google Photos") { openURL(url) }
                                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                        }
                        if imp.status == "expired" || imp.status == "failed" {
                            Button("Try again") { current = nil }
                                .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                        }
                    } else {
                        Text(initialAlbum.isEmpty
                             ? "Name the Waffled album, then pick photos in Google Photos. Your Google albums appear there; open one and select its photos."
                             : "Re-sync “\(initialAlbum)”: pick the album again in Google Photos and only the photos Waffled doesn’t have yet are copied.")
                            .font(.system(size: 13.5)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                        WaffledFieldCard(title: "Album") {
                            HStack {
                                TextField("e.g. Beach 2024", text: $album)
                                if !albums.isEmpty {
                                    Menu {
                                        ForEach(albums, id: \.self) { a in Button(a) { album = a } }
                                    } label: {
                                        Image(systemName: "chevron.down.circle").foregroundStyle(WF.ink3)
                                    }
                                }
                            }
                            .padding(.horizontal, 13).padding(.vertical, 11).wfField(fill: WF.panel)
                        }
                        if let errorText {
                            Text(errorText).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                        }
                        Button { Task { await start() } } label: {
                            Text("Open Google Photos").font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity).padding(.vertical, 13)
                                .background(WF.primary)
                                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }
                        .disabled(trimmedAlbum.isEmpty || busy)
                        .opacity(trimmedAlbum.isEmpty || busy ? 0.5 : 1)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Google Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(current?.status == "done" ? "Done" : "Close") { dismiss() }.fontWeight(.semibold)
                }
            }
            .task(id: current?.id) { await poll() }
            .onAppear { if !seeded { album = initialAlbum; seeded = true } }
        }
    }

    private var trimmedAlbum: String { album.trimmingCharacters(in: .whitespaces) }

    private func start() async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let imp = try await api.startGooglePhotosImport(album: trimmedAlbum)
            current = imp
            if let url = URL(string: imp.pickerUri) { openURL(url) }
        } catch {
            errorText = "Couldn’t open Google Photos. Check the connection in Settings → Display."
        }
    }

    private func poll() async {
        guard let id = current?.id else { return }
        while !Task.isCancelled, current?.isActive == true {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let next = try? await api.googlePhotosImport(id: id) else { continue }
            current = next
            if next.status == "done" { onImported(next.album) }
        }
    }

    static func message(for imp: WaffledAPI.GooglePhotosImport) -> String {
        switch imp.status {
        case "picking":
            return "Pick photos in Google Photos, then tap Done there. This updates on its own."
        case "importing":
            return "Copying photos into “\(imp.album)”… \(imp.importedCount) so far."
        case "done":
            let noun = imp.importedCount == 1 ? "photo" : "photos"
            let skipped = imp.skippedCount > 0 ? " (\(imp.skippedCount) skipped — videos or already imported)" : ""
            return "Added \(imp.importedCount) \(noun) to “\(imp.album)”\(skipped). Photos added in Google later need another re-sync."
        case "expired":
            return "The Google Photos session ran out before anything was picked."
        default:
            return "The import failed\(imp.error.map { ": \($0)" } ?? "")."
        }
    }
}
