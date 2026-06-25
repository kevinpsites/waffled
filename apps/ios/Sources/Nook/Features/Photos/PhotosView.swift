import SwiftUI

/// The family photo wall — one adaptive screen for iPhone (2-column grid under a nav
/// title) and iPad (wider adaptive grid under a serif `KioskPageHeader`). Tiles show a
/// stored image (resolved through `MediaURL`) or an emoji-on-gradient fallback; tapping
/// one opens the detail sheet. The toolbar "Add" opens the PHPicker upload sheet.
struct PhotosView: View {
    @State private var model = PhotosModel()
    @State private var detail: NookAPI.Photo?
    @State private var showAdd = false
    @State private var selectedAlbum: String?     // nil = all photos
    @State private var playing = false            // the manual slideshow is up

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// The photos currently on the wall — all, or just the chosen album. Drives both
    /// the grid and what "Play" runs through.
    private var shownPhotos: [NookAPI.Photo] {
        guard let a = selectedAlbum else { return model.photos }
        return model.photos.filter { $0.memory == a }
    }

    var body: some View {
        Group {
            if isKiosk { kioskContent } else { phoneContent }
        }
        .background(NK.canvas)
        .navigationTitle("Photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAdd = true } label: {
                    Label("Add", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { playing = true } label: {
                    Label("Play", systemImage: "play.fill").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
                .disabled(shownPhotos.isEmpty)
            }
        }
        .task { if model.photos.isEmpty { await model.load() } }
        // The manual slideshow — a bare, chrome-free play-through of what's on the wall.
        .fullScreenCover(isPresented: $playing) {
            ScreensaverView(content: "photos", photos: shownPhotos, weather: nil, nextEvent: nil,
                            timezone: .current, dimmed: false, bare: true, onWake: { playing = false })
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
                    KioskHeaderButton(icon: "play.fill", label: "Play") { playing = true }
                        .opacity(shownPhotos.isEmpty ? 0.5 : 1).disabled(shownPhotos.isEmpty)
                    KioskHeaderButton(icon: "plus", label: "Add photos") { showAdd = true }
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
            NookLoading(top: 48)
        } else if model.photos.isEmpty {
            NookEmptyState(
                emoji: model.error ? "😕" : "📷",
                title: model.error ? "Couldn’t load photos" : "No photos yet",
                message: model.error ? "Pull to refresh to try again."
                                     : "Tap Add to upload your family’s moments.",
                top: 56)
        } else {
            LazyVGrid(columns: columns, spacing: tileHeight > 180 ? 14 : 12) {
                ForEach(shownPhotos) { photo in
                    Button { detail = photo } label: {
                        PhotoTile(photo: photo, height: tileHeight)
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
                .foregroundStyle(on ? NK.ink : NK.ink2)
                .padding(.horizontal, 13).padding(.vertical, 7)
                .nkChip(selected: on)
        }
        .buttonStyle(.plain)
    }
}

/// One tile on the wall: a stored image clipped to a rounded rect with a graceful
/// placeholder, or an emoji-on-gradient fallback. A ❤️ marks favorites; the caption
/// sits over the bottom of the tile.
struct PhotoTile: View {
    let photo: NookAPI.Photo
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
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .nkShadow1()
    }

    @ViewBuilder
    private var background: some View {
        if let url = MediaURL.resolve(photo.imageUrl) {
            // The image goes in an overlay over a flexible spacer so its (large)
            // scaledToFill size can't inflate the tile's layout width — otherwise the
            // grid measures the tile wider than its column and the row bleeds off-screen.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image.resizable().scaledToFill()
                        case .failure:
                            emojiTile
                        default:
                            ZStack { tint; ProgressView().tint(.white) }
                        }
                    }
                }
                .clipped()
        } else {
            emojiTile
        }
    }

    /// Emoji-on-gradient fallback using the photo's colorHex (fallback NK.panel).
    private var emojiTile: some View {
        ZStack {
            LinearGradient(colors: [tintSolid, tintSolid.opacity(0.7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Text(photo.emoji ?? "🏞️")
                .font(.system(size: height * 0.32))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var tintSolid: Color { Color(hexString: photo.colorHex) ?? NK.panel }
    private var tint: Color { tintSolid }
}
