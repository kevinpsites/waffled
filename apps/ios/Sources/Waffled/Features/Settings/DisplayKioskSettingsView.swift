import SwiftUI

/// Settings → Display & Kiosk. Edits the **household-wide** family-display config —
/// the screensaver, idle reset, and overnight dimming a wall tablet (or a browser
/// signed in as a kiosk) uses. These are the same settings the web kiosk exposes; the
/// phone is just a convenient remote for them. The per-device "use this as the
/// display" toggle and the live Preview are web-display-only, so they're omitted here.
struct DisplayKioskSettingsView: View {
    // RelativeDateTimeFormatter is expensive; reuse one for the per-device "Last seen" label.
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .short; return f
    }()

    @Environment(SyncManager.self) private var sync
    @Environment(KioskMode.self) private var kiosk
    @Environment(Session.self) private var session
    @State private var cfg: WaffledAPI.DisplayConfig?
    @State private var loadFailed = false
    @State private var dirty = false
    @State private var savedFlash = false
    @State private var saveFailed = false
    // For the live "Preview" of the screensaver.
    @State private var previewPhotos: [WaffledAPI.Photo] = []
    @State private var previewWeather: WaffledAPI.Weather?
    @State private var showPreview = false
    // Device-local: the server doesn't store a motion flag, and it's a per-display look.
    @AppStorage("waffled.screensaverMotion") private var motion = true
    // Shared-kiosk (this device) controls — iPad only.
    @State private var showCodeSheet = false
    @State private var confirmPromote = false
    @State private var confirmUnpair = false
    @State private var deviceBusy = false
    @State private var deviceError: String?
    // Household kiosk-device roster (moved here from the Households screen): the paired
    // tablets + "pair a new device". Admin-only.
    @State private var devices: [WaffledAPI.KioskDevice] = []
    @State private var showPair = false
    @State private var confirmRevoke: String?

    private let api = WaffledAPI()

    /// The device-level "make this a shared kiosk" card only makes sense on an iPad,
    /// and only a parent can flip it.
    private var showsDeviceCard: Bool { DeviceExperience.current == .kiosk && sync.isParent }

    /// The nav-rail picker (below) is iPad-only — the rail only exists in the kiosk shell.
    private var isIPad: Bool { DeviceExperience.current == .kiosk }

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
            VStack(alignment: .leading, spacing: 26) {
                // This iPad — device-local settings (only exist on the iPad kiosk shell).
                if isIPad {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionLabel(text: "This iPad")
                        Text("Only this iPad — these don’t change your other displays.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        if showsDeviceCard { deviceCard }
                        railSection
                    }
                }
                // Family displays — household-wide config + the roster of paired tablets.
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Family displays")
                    intro
                    if loadFailed {
                        errorCard
                    } else if cfg != nil {
                        if !sync.isParent { readOnlyNotice }
                        screensaverCard
                        idleCard
                        nightDimCard
                        if sync.isParent { kioskDevicesSection }
                        footnote
                    } else {
                        WaffledLoading()
                    }
                }
            }
            .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 110)
            .disabled(!sync.isParent)
        }
        .background(WF.canvas)
        .navigationTitle("Display & Kiosk").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if savedFlash {
                    Text("✓ Saved").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.success)
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showCodeSheet) { KioskCodeEntrySheet() }
        .sheet(isPresented: $showPair, onDismiss: { Task { await loadDevices() } }) {
            PairKioskSheet { await loadDevices() }
        }
        .confirmationDialog("Turn this iPad into a shared kiosk?", isPresented: $confirmPromote, titleVisibility: .visible) {
            Button("Turn on shared kiosk") { Task { await promote() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You’ll be signed out and the household picks a profile from a picker. You can switch back anytime.")
        }
        .confirmationDialog("Stop sharing this iPad?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Stop sharing", role: .destructive) { Task { await kiosk.unpair(sync: sync, session: session) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPad returns to a single sign-in. You’ll need to sign in again.")
        }
        .fullScreenCover(isPresented: $showPreview) {
            ScreensaverView(
                content: cfg?.content == "photos" ? "photos" : "clock",
                photos: cfg.map { WaffledAPI.screensaverPhotos(previewPhotos, $0) } ?? previewPhotos,
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
            .font(.system(size: 13)).foregroundStyle(WF.ink2)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: this-device shared-kiosk card (iPad only)

    private var deviceCard: some View {
        card {
            VStack(alignment: .leading, spacing: 14) {
                if kiosk.isShared {
                    rowLabel("This iPad is a shared kiosk", deviceSubtitle)
                    HStack(spacing: 10) {
                        pillButton("Switch profile", tint: WF.primary) { Task { await kiosk.returnToPicker(sync: sync) } }
                        pillButton("Stop sharing", tint: WF.ink2, faint: true) { confirmUnpair = true }
                    }
                } else {
                    rowLabel("Use this iPad as a shared kiosk",
                             "Show a profile picker so anyone in the household can tap their face to sign in — no shared password.")
                    pillButton(deviceBusy ? "Setting up…" : "Turn this iPad into a shared kiosk",
                               tint: WF.primary, wide: true) { confirmPromote = true }
                        .disabled(deviceBusy)
                    Button { showCodeSheet = true } label: {
                        Text("Pair with a code instead")
                            .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink2)
                    }
                    .buttonStyle(.plain)
                    if let deviceError {
                        Text(deviceError).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16)
        }
    }

    private var deviceSubtitle: String {
        if let l = kiosk.deviceLabel, !l.isEmpty { return "“\(l)” · anyone can switch from the picker." }
        return "Anyone can switch from the picker."
    }

    private func pillButton(_ label: String, tint: Color, wide: Bool = false, faint: Bool = false,
                            _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 14.5, weight: .bold))
                .foregroundStyle(faint ? WF.ink2 : .white)
                .frame(maxWidth: wide ? .infinity : nil)
                .padding(.horizontal, 18).padding(.vertical, 12)
                .background(faint ? WF.card2 : tint).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(WF.hair, lineWidth: faint ? 1 : 0))
        }
        .buttonStyle(.plain)
    }

    private func promote() async {
        deviceBusy = true; deviceError = nil
        deviceError = await kiosk.enableViaPromote(label: nil, sync: sync)
        deviceBusy = false
    }

    // MARK: nav-rail picker (iPad only)

    /// "Sidebar / navigation" — pick which destinations pin to the iPad rail. Stored
    /// per device (`KioskRail`); Today/Calendar/More/Settings are fixed and not shown.
    private var railSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Sidebar / navigation")
            KioskRailPickerCard()
            Text("Today and Calendar are always at the top; “More” holds anything you leave off. Saved on this iPad.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: kiosk devices (household — the paired tablets)

    private var kioskDevicesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Kiosk devices").padding(.top, 6)
            Text("Shared tablets paired to this household — each shows a profile picker instead of a single login.")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(devices) { d in deviceRow(d) }

            Button { showPair = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    Text("Pair a new device").font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(WF.ink2).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(WF.card2)
                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(WF.hair))
                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
            .buttonStyle(.plain).padding(.top, 2)
        }
    }

    private func deviceRow(_ d: WaffledAPI.KioskDevice) -> some View {
        HStack(spacing: 12) {
            Text("🖥️").font(.system(size: 20)).frame(width: 40, height: 40)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(d.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text(lastSeen(d.lastSeenAt)).font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 0)
            Button {
                if confirmRevoke == d.id { Task { await revoke(d.id) } } else { confirmRevoke = d.id }
            } label: {
                Text(confirmRevoke == d.id ? "Tap again" : "Unpair")
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(confirmRevoke == d.id ? WF.primary : WF.ink3)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(WF.panel).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(12).background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func lastSeen(_ iso: String?) -> String {
        guard let iso, let d = EventTime.parse(iso) else { return "Never connected" }
        return "Last seen \(Self.relative.localizedString(for: d, relativeTo: Date()))"
    }

    private var readOnlyNotice: some View {
        card {
            rowLabel("Only a parent can change these", "Ask an adult in your household to update the display.")
                .padding(.vertical, 14)
        }
    }

    private var footnote: some View {
        Text("Photos need a signed-in profile; the picker always shows the clock. Set a device as the display from the web kiosk under Display & Kiosk.")
            .font(.system(size: 12)).foregroundStyle(WF.ink3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var errorCard: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                rowLabel("Couldn’t load display settings", "Check your connection and try again.")
                Button { Task { await load() } } label: {
                    Text("Retry").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
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
                        .foregroundStyle(WF.primary)
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(WF.primary.opacity(0.1)).clipShape(Capsule())
                    }
                    .buttonStyle(.plain).disabled(cfg?.content == "off")
                }
                .padding(.vertical, 14)
                divider
                Toggle(isOn: bindBool(\.returnToPicker)) {
                    rowLabel("Return to profile picker afterward", "When a paired kiosk wakes, drop to the profile picker.")
                }
                .tint(WF.primary).padding(.vertical, 14)

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
                    .tint(WF.primary).padding(.vertical, 14)
                    divider
                    Toggle(isOn: $motion) {
                        rowLabel("Slow zoom on photos", "A gentle Ken-Burns drift, instead of letting each photo sit still. Saved on this device.")
                    }
                    .tint(WF.primary).padding(.vertical, 14)
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
                .tint(WF.primary).padding(.vertical, 14)
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
            Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(WF.ink)
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

    private func bindBool(_ kp: WritableKeyPath<WaffledAPI.DisplayConfig, Bool>) -> Binding<Bool> {
        Binding(get: { cfg?[keyPath: kp] ?? false },
                set: { cfg?[keyPath: kp] = $0; dirty = true })
    }

    private func bindTime(_ kp: WritableKeyPath<WaffledAPI.DisplayConfig, String>) -> Binding<Date> {
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
        if sync.isParent { await loadDevices() }
    }

    private func loadDevices() async {
        devices = (try? await api.kioskDevices()) ?? []
    }

    private func revoke(_ id: String) async {
        confirmRevoke = nil
        try? await api.revokeKioskDevice(id: id)
        await loadDevices()
    }

    private func save(_ snapshot: WaffledAPI.DisplayConfig) async {
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
        return Cal.current.date(from: c) ?? Date(timeIntervalSinceReferenceDate: 0)
    }

    private static func formatTime(_ date: Date) -> String {
        let c = Cal.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    // MARK: building blocks (mirrors NotificationsSettingsView)

    private func rowLabel(_ title: String, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
            Text(sub).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
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
                Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                WaffledSettingsMenuLabel(value: value)
            }
            .padding(.vertical, 15)
        }
    }

    private var divider: some View { Rectangle().fill(WF.hair).frame(height: 1) }

    @ViewBuilder
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(.horizontal, 18)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }
}
