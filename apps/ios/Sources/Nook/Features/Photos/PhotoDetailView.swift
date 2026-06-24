import SwiftUI

/// A photo's detail sheet: the large image (or emoji tile), caption, album, "added
/// by", date, a favorite toggle (PATCH isFavorite), and Delete (with confirm). An
/// inline Edit mode PATCHes caption + album. Mirrors web `PhotoDetail.tsx` in spirit.
struct PhotoDetailView: View {
    let photo: NookAPI.Photo
    var memoryCount: Int = 0
    var albums: [String] = []
    /// Called after any mutation (favorite / edit / delete) so the wall can refresh.
    var onChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    @State private var isFavorite: Bool
    @State private var editing = false
    @State private var caption: String
    @State private var album: String
    @State private var saving = false
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var errorText: String?

    private let api = NookAPI()
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    init(photo: NookAPI.Photo, memoryCount: Int = 0, albums: [String] = [], onChanged: @escaping () -> Void = {}) {
        self.photo = photo
        self.memoryCount = memoryCount
        self.albums = albums
        self.onChanged = onChanged
        _isFavorite = State(initialValue: photo.isFavorite)
        _caption = State(initialValue: photo.caption)
        _album = State(initialValue: photo.memory ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    stage
                    if editing { editCard } else { detailsCard }
                    if let errorText {
                        Text(errorText).font(.system(size: 13)).foregroundStyle(NK.primaryD)
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
        NookCard {
            VStack(alignment: .leading, spacing: 0) {
                if !photo.caption.isEmpty {
                    Text(photo.caption).font(NK.serif(22)).foregroundStyle(NK.ink)
                        .padding(.bottom, 12)
                }
                favoriteRow
                Divider().overlay(NK.hair)
                infoRow("Album", value: photo.memory ?? "—")
                Divider().overlay(NK.hair)
                addedByRow
                Divider().overlay(NK.hair)
                infoRow("Date", value: dateLabel)
                if let m = photo.memory, !m.isEmpty, memoryCount > 1 {
                    Divider().overlay(NK.hair)
                    Text("\(memoryCount) photos in “\(m)”")
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

    private var editCard: some View {
        NookFieldCard(title: "Edit photo") {
            VStack(alignment: .leading, spacing: 12) {
                Text("CAPTION").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                TextField("Caption", text: $caption).nkField()
                Text("ALBUM").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                TextField("Album (optional)", text: $album).nkField()
                if !albums.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(albums, id: \.self) { a in
                                Button { album = a } label: { Pill(text: a) }.buttonStyle(.plain)
                            }
                        }
                    }
                }
                Button { editing = false } label: {
                    Text("Cancel").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background(NK.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: date

    private var dateLabel: String {
        let raw = photo.takenAt ?? photo.createdAt
        guard let date = EventTime.parse(raw) else { return "—" }
        return DateFmt.string(date, "EEE, MMM d, yyyy", .current)
    }

    // MARK: actions

    private func startEdit() {
        caption = photo.caption
        album = photo.memory ?? ""
        editing = true
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
            "memory": trimmedAlbum.isEmpty ? .string("") : .string(trimmedAlbum),
            "isFavorite": .bool(isFavorite),
        ]
        do {
            _ = try await api.updatePhoto(id: photo.id, body)
            onChanged()
            editing = false
            dismiss()
        } catch {
            errorText = "Couldn’t save changes."
        }
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
