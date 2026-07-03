import SwiftUI

/// A photo's detail sheet: the large image (or emoji tile), caption, album, "added
/// by", date, a favorite toggle (PATCH isFavorite), and Delete (with confirm). An
/// inline Edit mode PATCHes caption + album. Mirrors web `PhotoDetail.tsx` in spirit.
struct PhotoDetailView: View {
    let photo: WaffledAPI.Photo
    var memoryCount: Int = 0
    var albums: [String] = []
    /// Called after any mutation (favorite / edit / delete) so the wall can refresh.
    var onChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    @State private var isFavorite: Bool
    @State private var editing = false
    @State private var caption: String
    @State private var album: String
    @State private var takenAt: Date
    @State private var saving = false
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var errorText: String?

    private let api = WaffledAPI()
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    init(photo: WaffledAPI.Photo, memoryCount: Int = 0, albums: [String] = [], onChanged: @escaping () -> Void = {}) {
        self.photo = photo
        self.memoryCount = memoryCount
        self.albums = albums
        self.onChanged = onChanged
        _isFavorite = State(initialValue: photo.isFavorite)
        _caption = State(initialValue: photo.caption)
        _album = State(initialValue: photo.memory ?? "")
        _takenAt = State(initialValue: EventTime.parse(photo.takenAt ?? photo.createdAt) ?? Date())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // In edit mode the fields lead and the photo shrinks to a preview, so
                    // it's obvious what you're editing without scrolling past a full image.
                    if editing {
                        editCard
                        stage.frame(maxHeight: 220)
                    } else {
                        stage
                        detailsCard
                    }
                    if let errorText {
                        Text(errorText).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.primaryD)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(isKiosk ? 24 : 16)
                .padding(.bottom, 40)
            }
            .background(NK.canvas)
            .navigationTitle("Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    if editing {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold).disabled(saving)
                    } else {
                        Menu {
                            Button { startEdit() } label: { Label("Edit", systemImage: "pencil") }
                            Button(role: .destructive) { confirmDelete = true } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .confirmationDialog("Delete photo?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await delete() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This can’t be undone.")
            }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
    }

    // MARK: stage (the big photo / emoji tile)

    private var stage: some View {
        ZStack(alignment: .bottomLeading) {
            if let url = MediaURL.resolve(photo.imageUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image): image.resizable().scaledToFit()
                    case .failure: emojiStage
                    default: ZStack { tint; ProgressView().tint(.white) }.frame(height: 280)
                    }
                }
            } else {
                emojiStage
            }
        }
        .frame(maxWidth: .infinity)
        .background(tint)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    private var emojiStage: some View {
        ZStack {
            LinearGradient(colors: [tint, tint.opacity(0.7)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(photo.emoji ?? "🏖️").font(.system(size: 92))
        }
        .frame(height: 280).frame(maxWidth: .infinity)
    }

    private var tint: Color { Color(hexString: photo.colorHex) ?? NK.panel }

    // MARK: details (read mode)

    private var detailsCard: some View {
        // Read-mode reflects the locally-saved values (caption / album / date) so a
        // just-saved edit is visible immediately — not the stale `photo` we opened with.
        let trimmedAlbum = album.trimmingCharacters(in: .whitespacesAndNewlines)
        return WaffledCard {
            VStack(alignment: .leading, spacing: 0) {
                if !caption.isEmpty {
                    Text(caption).font(NK.serif(22)).foregroundStyle(NK.ink)
                        .padding(.bottom, 12)
                }
                favoriteRow
                Divider().overlay(NK.hair)
                infoRow("Album", value: trimmedAlbum.isEmpty ? "—" : trimmedAlbum)
                Divider().overlay(NK.hair)
                addedByRow
                Divider().overlay(NK.hair)
                infoRow("Date", value: dateLabel)
                if !trimmedAlbum.isEmpty, memoryCount > 1 {
                    Divider().overlay(NK.hair)
                    Text("\(memoryCount) photos in “\(trimmedAlbum)”")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                        .padding(.top, 11)
                }
            }
        }
    }

    private var favoriteRow: some View {
        Button { Task { await toggleFavorite() } } label: {
            HStack {
                Text("Favorite").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Text(isFavorite ? "❤️" : "🤍").font(.system(size: 20))
            }
            .padding(.vertical, 11)
        }
        .buttonStyle(.plain).disabled(busy)
    }

    private func infoRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
            Spacer()
            Text(value).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 11)
    }

    private var addedByRow: some View {
        HStack {
            Text("Added by").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
            Spacer()
            if let by = photo.uploadedBy {
                HStack(spacing: 7) {
                    Avatar(colorHex: by.colorHex, emoji: by.avatarEmoji ?? "🙂", size: 26)
                    Text(by.name ?? "—").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
                }
            } else {
                Text("—").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink2)
            }
        }
        .padding(.vertical, 9)
    }

    // MARK: edit mode

    /// A labeled field group: the small caps label sitting just above its content, so
    /// each label reads as belonging to the field beneath it (not floating between two).
    @ViewBuilder
    private func field<V: View>(label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
            content()
        }
    }

    private var editCard: some View {
        WaffledFieldCard(title: "Edit photo") {
            VStack(alignment: .leading, spacing: 14) {
                field(label: "CAPTION") {
                    TextField("Add a caption", text: $caption)
                        .font(.system(size: 16))
                        .textInputAutocapitalization(.sentences)
                        .padding(.horizontal, 13).padding(.vertical, 12)
                        .nkField(fill: NK.panel)
                }
                field(label: "ALBUM") {
                    TextField("Album (optional)", text: $album)
                        .font(.system(size: 16))
                        .padding(.horizontal, 13).padding(.vertical, 12)
                        .nkField(fill: NK.panel)
                    if !albums.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(albums, id: \.self) { a in
                                    Button { album = a } label: { Pill(text: a) }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                field(label: "DATE") {
                    DatePicker("", selection: $takenAt, displayedComponents: .date)
                        .labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 13).padding(.vertical, 8)
                        .nkField(fill: NK.panel)
                }
                // Save sits right under the fields (in addition to the toolbar), so the
                // primary action is obvious without hunting for the top-right button.
                HStack(spacing: 10) {
                    Button { cancelEdit() } label: {
                        Text("Cancel").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(NK.panel).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(saving)
                    Button { Task { await save() } } label: {
                        Text(saving ? "Saving…" : "Save changes").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(NK.primary).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(saving)
                }
                .padding(.top, 2)
            }
        }
    }

    // MARK: date

    /// The currently-chosen date (seeded from the photo's taken_at, falling back to its
    /// upload date), formatted for the read-mode "Date" row.
    private var dateLabel: String {
        DateFmt.string(takenAt, "EEE, MMM d, yyyy", .current)
    }

    // MARK: actions

    private func startEdit() {
        caption = photo.caption
        album = photo.memory ?? ""
        takenAt = EventTime.parse(photo.takenAt ?? photo.createdAt) ?? Date()
        errorText = nil
        editing = true
    }

    private func cancelEdit() {
        caption = photo.caption
        album = photo.memory ?? ""
        takenAt = EventTime.parse(photo.takenAt ?? photo.createdAt) ?? Date()
        errorText = nil
        editing = false
    }

    /// Format a chosen day as an ISO timestamp at noon (device tz) for `taken_at`.
    private static func isoDay(_ d: Date) -> String {
        let noon = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: d) ?? d
        return ISO8601DateFormatter().string(from: noon)
    }

    private func toggleFavorite() async {
        busy = true; defer { busy = false }
        let next = !isFavorite
        do {
            _ = try await api.updatePhoto(id: photo.id, ["isFavorite": .bool(next)])
            isFavorite = next
            onChanged()
        } catch {
            errorText = "Couldn’t update favorite."
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true; defer { saving = false }
        let trimmedAlbum = album.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: [String: JSONValue] = [
            "caption": .string(caption.trimmingCharacters(in: .whitespacesAndNewlines)),
            // Empty album clears it — send null (an empty string isn't the same thing).
            "memory": trimmedAlbum.isEmpty ? .null : .string(trimmedAlbum),
            "isFavorite": .bool(isFavorite),
            // The photo's date (taken_at) — noon in the device tz so the day never
            // shifts when it round-trips through the display formatter.
            "takenAt": .string(Self.isoDay(takenAt)),
        ]
        do {
            _ = try await api.updatePhoto(id: photo.id, body)
            onChanged()
            // Return to read mode (don't dismiss) so the updated caption / album / date
            // is visible right here — otherwise the sheet closes and the change looks lost.
            editing = false
        } catch let WaffledAPI.APIError.http(code, msg) {
            // Surface the real reason instead of a generic message — a 403 means the
            // server didn't allow it, a 4xx usually carries a specific cause.
            let reason = Self.serverReason(msg)
            errorText = "Couldn’t save (error \(code))." + (reason.isEmpty ? "" : " \(reason)")
        } catch {
            errorText = "Couldn’t reach the server — check your connection and try again."
        }
    }

    /// Pull a human message out of an error JSON body (`{ "message": "…" }`), if any.
    private static func serverReason(_ body: String) -> String {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msg = obj["message"] as? String else { return "" }
        return msg
    }

    private func delete() async {
        do {
            try await api.deletePhoto(id: photo.id)
            onChanged()
            dismiss()
        } catch {
            errorText = "Couldn’t delete photo."
        }
    }
}
