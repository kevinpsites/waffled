import SwiftUI
import PhotosUI

/// Upload sheet: pick up to 10 photos with the system PHPicker (no Info.plist
/// permission needed), each uploads to the blob store as it's picked, then you give
/// each a caption / favorite / album before "Add" creates them via `createPhoto`.
/// A shared "album for all" default seeds new rows. Mirrors web `PhotoAdd.tsx`.
struct PhotoAddSheet: View {
    var albums: [String] = []
    /// Called after a successful batch create so the wall can refresh.
    var onDone: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    @State private var picks: [PhotosPickerItem] = []
    @State private var rows: [Row] = []
    @State private var sharedAlbum = ""
    @State private var creating = false
    @State private var errorText: String?

    private let api = WaffledAPI()
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// One staged upload — its thumbnail, the uploaded storage key (nil until done),
    /// editable caption / favorite / album, and per-row status.
    struct Row: Identifiable {
        let id = UUID()
        var image: UIImage?
        var storageKey: String?
        var caption = ""
        var album = ""
        var isFavorite = false
        var status: Status = .uploading
        enum Status: Equatable { case uploading, ready, failed(String) }
    }

    private var canAdd: Bool {
        !rows.isEmpty && rows.contains { $0.status == .ready } && !creating
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .images) {
                        HStack(spacing: 8) {
                            Image(systemName: "photo.on.rectangle.angled").font(.system(size: 16, weight: .bold))
                            Text(rows.isEmpty ? "Choose photos" : "Add more")
                                .font(.system(size: 15, weight: .bold))
                        }
                        .foregroundStyle(NK.primary)
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(NK.primary.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }

                    if !rows.isEmpty {
                        WaffledFieldCard(title: "Album for all (optional)") {
                            TextField("e.g. Summer trip", text: $sharedAlbum)
                                .padding(.horizontal, 13).padding(.vertical, 11).nkField(fill: NK.panel)
                                .onChange(of: sharedAlbum) { _, new in
                                    // Seed empty rows with the shared album.
                                    for i in rows.indices where rows[i].album.isEmpty { rows[i].album = new }
                                }
                            if !albums.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(albums, id: \.self) { a in
                                            Button { sharedAlbum = a } label: { Pill(text: a) }.buttonStyle(.plain)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    ForEach($rows) { $row in rowCard($row) }

                    if let errorText {
                        Text(errorText).font(.system(size: 13)).foregroundStyle(NK.primaryD)
                    }

                    if !rows.isEmpty {
                        WaffledPrimaryCTA(label: creating ? "Adding…" : "Add to wall",
                                       isBusy: creating, isDisabled: !canAdd) {
                            Task { await create() }
                        }
                    }
                }
                .padding(isKiosk ? 24 : 16)
                .padding(.bottom, 40)
            }
            .background(NK.canvas)
            .navigationTitle("Add photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onChange(of: picks) { _, items in Task { await ingest(items) } }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    // MARK: per-photo row

    private func rowCard(_ row: Binding<Row>) -> some View {
        WaffledCard {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(NK.panel)
                    if let img = row.wrappedValue.image {
                        Image(uiImage: img).resizable().scaledToFill()
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    switch row.wrappedValue.status {
                    case .uploading: ProgressView().tint(.white)
                    case .failed: Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.white).font(.system(size: 18))
                    case .ready: EmptyView()
                    }
                }
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    TextField("Caption", text: row.caption)
                        .padding(.horizontal, 13).padding(.vertical, 11).nkField(fill: NK.panel)
                    HStack(spacing: 8) {
                        TextField("Album", text: row.album)
                            .padding(.horizontal, 13).padding(.vertical, 11).nkField(fill: NK.panel)
                        Button { row.wrappedValue.isFavorite.toggle() } label: {
                            Text(row.wrappedValue.isFavorite ? "❤️" : "🤍").font(.system(size: 20))
                                .frame(width: 44, height: 44)
                                .background(NK.panel)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                    if case let .failed(msg) = row.wrappedValue.status {
                        Text(msg).font(.system(size: 12)).foregroundStyle(NK.primaryD)
                    }
                }
            }
        }
    }

    // MARK: ingest (load + upload each picked item)

    @MainActor
    private func ingest(_ items: [PhotosPickerItem]) async {
        // Reset the picker selection token so the next pick fires onChange again.
        defer { picks = [] }
        for item in items {
            var row = Row()
            rows.append(row)
            let index = rows.count - 1
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    throw Failure.decode
                }
                rows[index].image = image
                let uploaded = try await api.uploadImage(image)
                rows[index].storageKey = uploaded.key
                rows[index].status = .ready
                if !sharedAlbum.isEmpty { rows[index].album = sharedAlbum }
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? "Couldn’t upload this photo."
                rows[index].status = .failed(msg)
            }
            _ = row
        }
    }

    private enum Failure: LocalizedError {
        case decode
        var errorDescription: String? { "Couldn’t read this photo." }
    }

    // MARK: create the staged photos

    private func create() async {
        guard !creating else { return }
        creating = true; defer { creating = false }
        errorText = nil
        var failures = 0
        for row in rows where row.status == .ready {
            guard let key = row.storageKey else { continue }
            let album = row.album.trimmingCharacters(in: .whitespacesAndNewlines)
            var body: [String: JSONValue] = [
                "storageKey": .string(key),
                "caption": .string(row.caption.trimmingCharacters(in: .whitespacesAndNewlines)),
                "isFavorite": .bool(row.isFavorite),
            ]
            body["memory"] = album.isEmpty ? .null : .string(album)
            do {
                _ = try await api.createPhoto(body)
            } catch {
                failures += 1
            }
        }
        if failures > 0 {
            errorText = "\(failures) photo\(failures == 1 ? "" : "s") couldn’t be added. Try again."
            onDone()   // still refresh — some may have succeeded
        } else {
            onDone()
            dismiss()
        }
    }
}
