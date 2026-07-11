import SwiftUI

/// The family photo wall — one adaptive screen for iPhone (2-column grid under a nav
/// title) and iPad (wider adaptive grid under a serif `KioskPageHeader`). Tiles show a
/// stored image (resolved through `MediaURL`) or an emoji-on-gradient fallback; tapping
/// one opens the detail sheet. The toolbar "Add" opens the PHPicker upload sheet.
struct PhotosView: View {
    @State private var model = PhotosModel()
    @State private var detail: WaffledAPI.Photo?
    @State private var showAdd = false
    @State private var selectedAlbum: String?     // nil = all photos
    @State private var playing = false            // the manual slideshow is up
    @AppStorage("waffled.screensaverMotion") private var motion = true

    // Multi-select bulk actions (move to album / delete)
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var showMove = false
    @State private var showDelete = false
    @State private var showNewAlbum = false
    @State private var newAlbumName = ""
    @State private var busy = false

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// The photos currently on the wall — all, or just the chosen album. Drives both
    /// the grid and what "Play" runs through.
    private var shownPhotos: [WaffledAPI.Photo] {
        guard let a = selectedAlbum else { return model.photos }
        return model.photos.filter { $0.memory == a }
    }

    var body: some View {
        Group {
            if isKiosk { kioskContent } else { phoneContent }
        }
        .background(WF.canvas)
        .navigationTitle("Photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            if selecting {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { exitSelection() }.fontWeight(.semibold)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(allSelected ? "Deselect All" : "Select All") { toggleSelectAll() }
                        .fontWeight(.semibold).disabled(shownPhotos.isEmpty)
                }
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    Button { playing = true } label: {
                        Label("Play", systemImage: "play.fill").labelStyle(.titleAndIcon).fontWeight(.semibold)
                    }
                    .disabled(shownPhotos.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Select") { enterSelection() }.fontWeight(.semibold)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showAdd = true } label: {
                        Label("Add", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if selecting { selectionBar }
        }
        .confirmationDialog(moveTitle, isPresented: $showMove, titleVisibility: .visible) {
            ForEach(model.albums, id: \.self) { album in
                Button(album) { runMove(to: album) }
            }
            Button("New album…") { showNewAlbum = true }
            Button("Remove from album") { runMove(to: nil) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New album", isPresented: $showNewAlbum) {
            TextField("Album name", text: $newAlbumName)
            Button("Cancel", role: .cancel) { newAlbumName = "" }
            Button("Move") {
                let name = newAlbumName.trimmingCharacters(in: .whitespaces)
                newAlbumName = ""
                if !name.isEmpty { runMove(to: name) }
            }
        } message: { Text("Move \(moveCountLabel) into a new album.") }
        .confirmationDialog("Delete \(moveCountLabel)?", isPresented: $showDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { runDelete() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This removes them from your family wall.") }
        .task { if model.photos.isEmpty { await model.load() } }
        // The manual slideshow — a bare, chrome-free play-through of what's on the wall.
        .fullScreenCover(isPresented: $playing) {
            ScreensaverView(content: "photos", photos: shownPhotos, weather: nil, nextEvent: nil,
                            timezone: .current, dimmed: false, bare: true, motion: motion,
                            onWake: { playing = false })
        }
        .sheet(item: $detail) { photo in
            PhotoDetailView(photo: photo, memoryCount: photo.memory.map { model.count(inMemory: $0) } ?? 0,
                            albums: model.albums,
                            onChanged: { Task { await model.load() } })
        }
        .sheet(isPresented: $showAdd) {
            PhotoAddSheet(albums: model.albums, onDone: { Task { await model.load() } })
        }
    }

    // MARK: iPhone — 2-column grid under a nav title

    private var phoneContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                albumFilter
                grid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                     tileHeight: 150)
                    .padding(.horizontal, 16)
            }
            .padding(.top, 12).padding(.bottom, 110)
        }
        .scrollBounceBehavior(.always)
        .refreshable { await model.load() }
    }

    // MARK: iPad — wider adaptive grid under a serif header

    private var kioskContent: some View {
        VStack(spacing: 14) {
            KioskPageHeader("Photos", "Your family's moments, all in one place.") {
                HStack(spacing: 10) {
                    if selecting {
                        KioskHeaderButton(icon: "checklist", label: allSelected ? "Deselect all" : "Select all") { toggleSelectAll() }
                            .opacity(shownPhotos.isEmpty ? 0.5 : 1).disabled(shownPhotos.isEmpty)
                        KioskHeaderButton(icon: "xmark", label: "Cancel") { exitSelection() }
                    } else {
                        KioskHeaderButton(icon: "play.fill", label: "Play") { playing = true }
                            .opacity(shownPhotos.isEmpty ? 0.5 : 1).disabled(shownPhotos.isEmpty)
                        KioskHeaderButton(icon: "checkmark.circle", label: "Select") { enterSelection() }
                            .opacity(model.photos.isEmpty ? 0.5 : 1).disabled(model.photos.isEmpty)
                        KioskHeaderButton(icon: "plus", label: "Add photos") { showAdd = true }
                    }
                }
            }
            albumFilter
            ScrollView(showsIndicators: false) {
                grid(columns: [GridItem(.adaptive(minimum: 220, maximum: 300), spacing: 14)],
                     tileHeight: 220)
                    .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.always)
            .refreshable { await model.load() }
        }
        .padding(.horizontal, 28).padding(.top, 20)
    }

    // MARK: shared grid

    @ViewBuilder
    private func grid(columns: [GridItem], tileHeight: CGFloat) -> some View {
        if model.loading && model.photos.isEmpty {
            WaffledLoading(top: 48)
        } else if model.photos.isEmpty {
            WaffledEmptyState(
                emoji: model.error ? "😕" : "📷",
                title: model.error ? "Couldn’t load photos" : "No photos yet",
                message: model.error ? "Pull to refresh to try again."
                                     : "Tap Add to upload your family’s moments.",
                top: 56)
        } else {
            LazyVGrid(columns: columns, spacing: tileHeight > 180 ? 14 : 12) {
                ForEach(shownPhotos) { photo in
                    let picked = selection.contains(photo.id)
                    Button {
                        if selecting { toggle(photo.id) } else { detail = photo }
                    } label: {
                        PhotoTile(photo: photo, height: tileHeight)
                            .overlay {
                                if selecting && picked {
                                    RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                                        .strokeBorder(WF.primary, lineWidth: 3)
                                }
                            }
                            .overlay(alignment: .topLeading) {
                                if selecting { selectBadge(on: picked).padding(8) }
                            }
                            .opacity(selecting && !picked ? 0.78 : 1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Album chips — All + each album — so the wall (and "Play") can scope to one album.
    /// Hidden until there's more than one album to choose between.
    @ViewBuilder
    private var albumFilter: some View {
        if !model.albums.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    albumChip("All photos", value: nil)
                    ForEach(model.albums, id: \.self) { albumChip($0, value: $0) }
                }
                .padding(.horizontal, isKiosk ? 0 : 16)
            }
        }
    }

    private func albumChip(_ label: String, value: String?) -> some View {
        let on = selectedAlbum == value
        return Button { selectedAlbum = value } label: {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? WF.ink : WF.ink2)
                .padding(.horizontal, 13).padding(.vertical, 7)
                .wfChip(selected: on)
        }
        .buttonStyle(.plain)
    }

    // MARK: multi-select

    /// The floating action bar shown while selecting — Move / Delete + a live count.
    private var selectionBar: some View {
        HStack(spacing: 18) {
            Button { showMove = true } label: {
                Label("Move", systemImage: "folder").fontWeight(.semibold)
            }
            .disabled(selection.isEmpty || busy)
            Button(role: .destructive) { showDelete = true } label: {
                Label("Delete", systemImage: "trash").fontWeight(.semibold)
            }
            .disabled(selection.isEmpty || busy)
            Spacer(minLength: 8)
            if busy { ProgressView() }
            Text(selection.isEmpty ? "Select photos" : "\(selection.count) selected")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
        }
        .padding(.horizontal, 20).padding(.vertical, 13)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(WF.ink3.opacity(0.18)))
        .wfShadow1()
        .padding(.horizontal, isKiosk ? 28 : 16)
        .padding(.bottom, isKiosk ? 18 : 94)   // clear the iPhone tab bar
    }

    private func selectBadge(on: Bool) -> some View {
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(on ? .white : .white.opacity(0.95), on ? WF.primary : .clear)
            .background(Circle().fill(on ? Color.white : Color.black.opacity(0.28)).padding(3))
            .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
    }

    private var allSelected: Bool {
        !shownPhotos.isEmpty && selection.count == shownPhotos.count
    }
    private var moveCountLabel: String {
        "\(selection.count) photo\(selection.count == 1 ? "" : "s")"
    }
    private var moveTitle: String { "Move \(moveCountLabel)" }

    private func enterSelection() { selecting = true; selection = [] }
    private func exitSelection() { selecting = false; selection = [] }
    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }
    private func toggleSelectAll() {
        selection = allSelected ? [] : Set(shownPhotos.map(\.id))
    }

    private func runMove(to album: String?) {
        let ids = selection
        guard !ids.isEmpty else { return }
        Task {
            busy = true
            _ = await model.move(ids, toAlbum: album)
            busy = false
            exitSelection()
        }
    }
    private func runDelete() {
        let ids = selection
        guard !ids.isEmpty else { return }
        Task {
            busy = true
            _ = await model.delete(ids)
            busy = false
            exitSelection()
        }
    }
}

/// One tile on the wall: a stored image clipped to a rounded rect with a graceful
/// placeholder, or an emoji-on-gradient fallback. A ❤️ marks favorites; the caption
/// sits over the bottom of the tile.
struct PhotoTile: View {
    let photo: WaffledAPI.Photo
    var height: CGFloat = 150

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            background
            // Caption + favorite overlay
            if photo.isFavorite || !photo.caption.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Spacer(minLength: 0)
                    HStack(alignment: .bottom, spacing: 6) {
                        if !photo.caption.isEmpty {
                            Text(photo.caption)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(2)
                                .shadow(color: .black.opacity(0.45), radius: 3, y: 1)
                        }
                        Spacer(minLength: 0)
                        if photo.isFavorite {
                            Text("❤️").font(.system(size: 14))
                                .shadow(color: .black.opacity(0.35), radius: 2)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        LinearGradient(colors: [.clear, .black.opacity(0.42)],
                                       startPoint: .top, endPoint: .bottom)
                    )
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .wfShadow1()
    }

    @ViewBuilder
    private var background: some View {
        if photo.imageUrl != nil {
            // The image goes in an overlay over a flexible spacer so its (large)
            // scaledToFill size can't inflate the tile's layout width — otherwise the
            // grid measures the tile wider than its column and the row bleeds off-screen.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    CachedImage(photo.imageUrl) { emojiTile }
                }
                .clipped()
        } else {
            emojiTile
        }
    }

    /// Emoji-on-gradient fallback using the photo's colorHex (fallback WF.panel).
    private var emojiTile: some View {
        ZStack {
            LinearGradient(colors: [tintSolid, tintSolid.opacity(0.7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(photo.emoji ?? "🏞️")
                .font(.system(size: height * 0.32))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var tintSolid: Color { Color(hexString: photo.colorHex) ?? WF.panel }
}
