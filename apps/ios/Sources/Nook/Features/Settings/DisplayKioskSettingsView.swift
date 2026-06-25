import SwiftUI

/// Settings → Display & Kiosk. Edits the **household-wide** family-display config —
/// the screensaver, idle reset, and overnight dimming a wall tablet (or a browser
/// signed in as a kiosk) uses. These are the same settings the web kiosk exposes; the
/// phone is just a convenient remote for them. The per-device "use this as the
/// display" toggle and the live Preview are web-display-only, so they're omitted here.
struct DisplayKioskSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var cfg: NookAPI.DisplayConfig?
    @State private var loadFailed = false
    @State private var dirty = false
    @State private var savedFlash = false
    @State private var saveFailed = false
    // For the live "Preview" of the screensaver.
    @State private var previewPhotos: [NookAPI.Photo] = []
    @State private var previewWeather: NookAPI.Weather?
    @State private var showPreview = false
    // Device-local: the server doesn't store a motion flag, and it's a per-display look.
    @AppStorage("nook.screensaverMotion") private var motion = true

    private let api = NookAPI()

    /// The soonest upcoming event, for the preview's "Next:" line.
    private var nextEvent: SyncedEvent? {
        let now = Date()
        return sync.events
            .filter { ($0.startsAt ?? .distantPast) >= now }
            .min { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }
    }

    // Preset choices (the web uses free-entry number fields; menus read cleaner on a
    // phone and the server clamps anything out of range regardless).
    private let screensaverChoices = [1, 2, 3, 5, 10, 15, 30, 60]
    private let idleChoices = [0, 1, 2, 3, 5, 10, 15, 30]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                intro
                if loadFailed {
                    errorCard
                } else if cfg != nil {
                    if !sync.isParent { readOnlyNotice }
                    screensaverCard
                    idleCard
                    nightDimCard
                    footnote
                } else {
                    NookLoading()
                }
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 110)
            .disabled(!sync.isParent)
        }
        .background(NK.canvas)
        .navigationTitle("Display & Kiosk").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if savedFlash {
                    Text("✓ Saved").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: 0x25A368))
                }
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $showPreview) {
            ScreensaverView(
                content: cfg?.content == "photos" ? "photos" : "clock",
                photos: cfg.map { NookAPI.screensaverPhotos(previewPhotos, $0) } ?? previewPhotos,
                weather: previewWeather, nextEvent: nextEvent, timezone: sync.householdTz,
                dimmed: false, interval: cfg?.photoInterval ?? 8, bare: false, motion: motion,
                onWake: { showPreview = false })
        }
        // Debounced auto-save — echoing the server's normalized cfg back into state
        // must not retrigger a save, hence the `dirty` guard.
        .task(id: cfg) {
            guard dirty, let snapshot = cfg else { return }
            try? await Task.sleep(for: .milliseconds(600))
            if Task.isCancelled { return }
            await save(snapshot)
        }
    }

    // MARK: copy

    private var intro: some View {
        Text("These control the **family display** — a wall tablet or a browser signed in as a kiosk. Changes apply to every display in your home.")
            .font(.system(size: 13)).foregroundStyle(NK.ink2)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var readOnlyNotice: some View {
        card {
            rowLabel("Only a parent can change these", "Ask an adult in your household to update the display.")
                .padding(.vertical, 14)
        }
    }

    private var footnote: some View {
        Text("Photos need a signed-in profile; the picker always shows the clock. Set a device as the display from the web kiosk under Display & Kiosk.")
            .font(.system(size: 12)).foregroundStyle(NK.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var errorCard: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                rowLabel("Couldn’t load display settings", "Check your connection and try again.")
                Button { Task { await load() } } label: {
                    Text("Retry").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.primary)
                }.buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16)
        }
    }

    // MARK: cards

    private var screensaverCard: some View {
        card {
            VStack(spacing: 0) {
                menuRow("Screensaver after", value: minutesLabel(cfg?.screensaverMinutes ?? 15)) {
                    ForEach(screensaverChoices, id: \.self) { m in
                        Button(minutesLabel(m)) { cfg?.screensaverMinutes = m; dirty = true }
                    }
                }
                divider
                VStack(alignment: .leading, spacing: 10) {
                    rowLabel("What it shows", "“Photos + clock” is a slideshow with the clock, weather & next event overlaid.")
                    Picker("", selection: bindContent) {
                        Text("Photos").tag("photos")
                        Text("Clock").tag("clock")
                        Text("Off").tag("off")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    // See it right now — full-screen, tap to dismiss.
                    Button { showPreview = true } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "play.fill").font(.system(size: 12, weight: .bold))
                            Text("Preview").font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(NK.primary)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(NK.primary.opacity(0.1)).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(cfg?.content == "off")
                }
                .padding(.vertical, 14)
                divider
                Toggle(isOn: bindBool(\.returnToPicker)) {
                    rowLabel("Return to profile picker afterward", "When a paired kiosk wakes, drop to the profile picker.")
                }
                .tint(NK.primary).padding(.vertical, 14)

                // Photo-slideshow options — only relevant when the saver shows photos.
                if cfg?.content == "photos" {
                    divider
                    VStack(alignment: .leading, spacing: 10) {
                        rowLabel("Photo source", "Which photos the slideshow plays.")
                        Picker("", selection: bindPhotoSource) {
                            Text("All").tag("all")
                            Text("Favorites").tag("favorites")
                            Text("Album").tag("album")
                        }
                        .pickerStyle(.segmented).labelsHidden()
                    }
                    .padding(.vertical, 14)
                    if cfg?.photoSource == "album" {
                        divider
                        menuRow("Album", value: cfg?.photoAlbum ?? "Choose…") {
                            if albumChoices.isEmpty {
                                Text("No albums yet — tag photos with an album first.")
                            } else {
                                ForEach(albumChoices, id: \.self) { a in
                                    Button(a) { cfg?.photoAlbum = a; dirty = true }
                                }
                            }
                        }
                    }
                    divider
                    menuRow("Transition speed", value: secondsLabel(cfg?.photoInterval ?? 8)) {
                        ForEach(intervalChoices, id: \.self) { s in
                            Button(secondsLabel(s)) { cfg?.photoInterval = s; dirty = true }
                        }
                    }
                    divider
                    Toggle(isOn: bindBool(\.photoShuffle)) {
                        rowLabel("Shuffle photos", "Play them in a random order.")
                    }
                    .tint(NK.primary).padding(.vertical, 14)
                    divider
                    Toggle(isOn: $motion) {
                        rowLabel("Slow zoom on photos", "A gentle Ken-Burns drift, instead of letting each photo sit still. Saved on this device.")
                    }
                    .tint(NK.primary).padding(.vertical, 14)
                }
            }
        }
    }

    /// Album names seen across the household's photos (for the "Specific album" picker).
    private var albumChoices: [String] {
        Array(Set(previewPhotos.compactMap { $0.memory }.filter { !$0.isEmpty })).sorted()
    }
    private let intervalChoices = [3, 5, 8, 10, 15, 20, 30]
    private func secondsLabel(_ s: Int) -> String { s == 1 ? "1 second" : "\(s) seconds" }

    private var bindPhotoSource: Binding<String> {
        Binding(get: { cfg?.photoSource ?? "all" },
                set: { cfg?.photoSource = $0; dirty = true })
    }

    private var idleCard: some View {
        card {
            menuRow("Return to Today when idle", value: idleLabel(cfg?.resetHomeMinutes ?? 3)) {
                ForEach(idleChoices, id: \.self) { m in
                    Button(idleLabel(m)) { cfg?.resetHomeMinutes = m; dirty = true }
                }
            }
        }
    }

    private var nightDimCard: some View {
        card {
            VStack(spacing: 0) {
                Toggle(isOn: bindBool(\.nightDim.enabled)) {
                    rowLabel("Night dimming", "Dim the display overnight on a schedule.")
                }
                .tint(NK.primary).padding(.vertical, 14)
                if cfg?.nightDim.enabled == true {
                    divider
                    timeRow("Dim from", bindTime(\.nightDim.start))
                    divider
                    timeRow("Back to bright at", bindTime(\.nightDim.end))
                }
            }
        }
    }

    private func timeRow(_ title: String, _ value: Binding<Date>) -> some View {
        HStack {
            Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(NK.ink)
            Spacer(minLength: 8)
            DatePicker("", selection: value, displayedComponents: .hourAndMinute)
                .labelsHidden()
        }
        .padding(.vertical, 9)
    }

    // MARK: bindings — controls only render when `cfg != nil`, so the force-unwrap is safe.

    private var bindContent: Binding<String> {
        Binding(get: { cfg?.content ?? "photos" },
                set: { cfg?.content = $0; dirty = true })
    }

    private func bindBool(_ kp: WritableKeyPath<NookAPI.DisplayConfig, Bool>) -> Binding<Bool> {
        Binding(get: { cfg?[keyPath: kp] ?? false },
                set: { cfg?[keyPath: kp] = $0; dirty = true })
    }

    private func bindTime(_ kp: WritableKeyPath<NookAPI.DisplayConfig, String>) -> Binding<Date> {
        Binding(get: { Self.parseTime(cfg?[keyPath: kp] ?? "00:00") },
                set: { cfg?[keyPath: kp] = Self.formatTime($0); dirty = true })
    }

    // MARK: data

    private func load() async {
        loadFailed = false
        // Fetch config + the preview's photos/weather concurrently, so a tapped Preview
        // has real photos to show instead of a blank slideshow.
        async let cfgF = api.displayConfig()
        async let wxF = api.weather()
        async let photosF = api.photos()
        do { cfg = try await cfgF; dirty = false }
        catch { loadFailed = true }
        previewWeather = try? await wxF
        previewPhotos = (try? await photosF) ?? []
    }

    private func save(_ snapshot: NookAPI.DisplayConfig) async {
        do {
            let normalized = try await api.setDisplayConfig(snapshot)
            cfg = normalized
            dirty = false
            saveFailed = false
            savedFlash = true
            try? await Task.sleep(for: .milliseconds(1800))
            savedFlash = false
        } catch {
            saveFailed = true
        }
    }

    // MARK: formatting

    private func minutesLabel(_ m: Int) -> String { m == 1 ? "1 min" : "\(m) min" }
    private func idleLabel(_ m: Int) -> String { m == 0 ? "Never" : minutesLabel(m) }

    private static func parseTime(_ hhmm: String) -> Date {
        let parts = hhmm.split(separator: ":")
        var c = DateComponents()
        c.hour = Int(parts.first ?? "0") ?? 0
        c.minute = parts.count > 1 ? (Int(parts[1]) ?? 0) : 0
        return Calendar.current.date(from: c) ?? Date(timeIntervalSinceReferenceDate: 0)
    }

    private static func formatTime(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    // MARK: building blocks (mirrors NotificationsSettingsView)

    private func rowLabel(_ title: String, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
            Text(sub).font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func menuRow<Content: View>(_ title: String, value: String, @ViewBuilder menu: () -> Content) -> some View {
        Menu {
            menu()
        } label: {
            HStack {
                Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(NK.ink)
                Spacer(minLength: 8)
                NookSettingsMenuLabel(value: value)
            }
            .padding(.vertical, 15)
        }
    }

    private var divider: some View { Rectangle().fill(NK.hair).frame(height: 1) }

    @ViewBuilder
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 18)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
    }
}
