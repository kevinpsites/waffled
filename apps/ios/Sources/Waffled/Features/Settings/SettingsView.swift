import SwiftUI

/// The household color palette — shared by the person + currency editors. Mirrors
/// the web kiosk's member swatches.
enum WaffledSwatch {
    static let all = ["#2F7FED", "#EC6049", "#25A368", "#8B5CF6", "#E0A500", "#EC4899", "#14B8A6", "#6B7280"]
}

/// A row of color swatches with the current one ringed.
struct ColorSwatchPicker: View {
    @Binding var hex: String
    var body: some View {
        HStack(spacing: 10) {
            ForEach(WaffledSwatch.all, id: \.self) { s in
                Circle().fill(Color(hexString: s) ?? WF.ink3)
                    .frame(width: 30, height: 30)
                    .overlay(Circle().strokeBorder(hex.lowercased() == s.lowercased() ? WF.ink : .clear, lineWidth: 2.5).padding(-3))
                    .onTapGesture { hex = s }
            }
            Spacer(minLength: 0)
        }
    }
}

/// Settings landing — pushes into the built-out panels; the rest are flagged as
/// coming soon so the hub never dead-ends.
struct SettingsView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @Environment(Session.self) private var session
    @Environment(NotificationManager.self) private var notifications
    @State private var confirmSignOut = false
    @State private var busy = false
    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }

    var body: some View {
        ScrollView {
            // Web order (with Accounts before AI, per the kiosk's pending update).
            // Three tiers mirroring the web (Account · Family · System): who you are →
            // the shared features an admin configures → the deployment. Family + System
            // are admin-only, so a non-admin cleanly sees just Account + About. Mobile
            // adaptations: "Accounts" holds your households + sign-in (web splits those
            // into Households/Security); Notifications is personal, so it stays in Account.
            VStack(alignment: .leading, spacing: 10) {
                // Account — you (personal; always visible)
                SectionLabel(text: "Account")
                row("🏠", "Households", "Your households & sign-in") { path.append(.settingsAccount) }
                row("🔔", "Notifications", "Your event reminders") { path.append(.settingsNotifications) }

                if isAdmin {
                    // Family — shared household configuration. The feature rows follow the
                    // same order as Settings → Modules (chores · goals · meals · lists ·
                    // pantry · family night) so the two screens line up; Goals has no
                    // settings screen of its own, so it's simply absent here.
                    SectionLabel(text: "Family").padding(.top, 8)
                    row("👨‍👩‍👧‍👦", "Family & People", "Members, roles, household") { path.append(.settingsFamily) }
                    row("📅", "Calendars", "Google sync") { path.append(.settingsCalendars) }
                    row("⭐", "Chores & Rewards", "Currencies & conversions") { path.append(.settingsChoresRewards) }
                    row("🍽️", "Meals", "Calendar & meal times") { path.append(.settingsMeals) }
                    row("📋", "Lists", "Grocery & lists")
                    if sync.module(.pantry) {
                        row("🥫", "Pantry", "Today card & thresholds") { path.append(.settingsPantry) }
                    }
                    if sync.module(.familyNight) {
                        row("🏡", "Family Night", "Agenda, day & time") { path.append(.settingsFamilyNight) }
                    }
                    row("🧩", "Modules", "Optional features on/off") { path.append(.settingsModules) }
                    row("🖥️", "Display & Kiosk", "Screensaver & idle") { path.append(.settingsDisplay) }
                }

                // System — device access (personal, every user on this device) + deployment
                // config (admin-only). Always visible so anyone can manage their own
                // permissions; AI & Capture stays admin-gated.
                SectionLabel(text: "System").padding(.top, 8)
                row("🌗", "Appearance", "Light, dark or match system") { path.append(.settingsAppearance) }
                if isAdmin {
                    row("✨", "AI & Capture", "Provider & model") { path.append(.settingsAI) }
                }
                row("🔐", "Permissions", "Apple Health & device access") { path.append(.settingsPermissions) }

                // About + sign out (ungrouped, always visible)
                row("ℹ️", "About", "Version & server") { path.append(.settingsAbout) }
                    .padding(.top, 8)
                signOutFooter
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .task { await sync.loadIdentity() }
    }

    /// Sign out lives right on the Settings landing (mirrors the web's footer).
    private var signOutFooter: some View {
        VStack(spacing: 8) {
            if let name = signedInName {
                Text("Signed in as \(name)").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            }
            Button {
                if confirmSignOut { Task { await signOut() } } else { confirmSignOut = true }
            } label: {
                Text(busy ? "Signing out…" : (confirmSignOut ? "Tap again to sign out" : "Sign out"))
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(confirmSignOut ? .white : WF.primary)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(confirmSignOut ? WF.primary : WF.card)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                        .strokeBorder(confirmSignOut ? .clear : WF.primary.opacity(0.4), lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(busy)
        }
        .padding(.top, 14)
    }

    private var signedInName: String? {
        sync.members.first { $0.id == sync.currentPersonId }?.name
    }

    private func signOut() async {
        busy = true
        await session.signOut()    // clear session, → login (Button's Task survives)
        await sync.signOut()       // disconnect sync
        await notifications.clearOurs()   // drop this household's local reminders
    }

    /// A settings row. `tap == nil` ⇒ not built yet (dimmed + a "Soon" pill).
    private func row(_ emoji: String, _ title: String, _ sub: String, tap: (() -> Void)? = nil) -> some View {
        let enabled = tap != nil
        return Button { tap?() } label: {
            HStack(spacing: 12) {
                WaffledEmojiTile(emoji: emoji)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(enabled ? WF.ink : WF.ink2)
                    Text(sub).font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
                if enabled {
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                } else {
                    Text("Soon").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                        .padding(.horizontal, 8).padding(.vertical, 3).background(WF.panel).clipShape(Capsule())
                }
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            .opacity(enabled ? 1 : 0.6)
        }
        .buttonStyle(.plain).disabled(!enabled)
    }
}

// MARK: - Modules (optional features on/off)

/// Settings → Modules — turn optional feature areas on/off for the whole household
/// (mirrors the web Modules tab). Available modules toggle; planned ones show as
/// "coming soon". Rewards is a sub-toggle of Chores. Writes are admin-only (server-
/// gated); non-admins see the state read-only. Toggling reloads `sync` so the phone's
/// Family grid / Today cards (and the iPad rail) update without a relaunch.
struct ModulesSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var flags: [String: Bool] = [:]
    @State private var rewards: Bool?            // nil until loaded
    @State private var loading = true
    @State private var saving: Set<String> = []  // keys mid-write (incl. "rewards")

    private let api = WaffledAPI()
    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }
    private func isOn(_ m: WaffledModule) -> Bool { flags[m.rawValue] ?? m.defaultOn }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Turn off whatever your family doesn’t use — its tab, Today card, and pages disappear everywhere. Today and Calendar always stay on.")
                    .font(.system(size: 13)).foregroundStyle(WF.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                if !isAdmin {
                    Text("Only an admin can change modules.")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                if loading {
                    WaffledLoading(top: 30)
                } else {
                    ForEach(WaffledModule.allCases.filter { $0.isAvailable }) { moduleCard($0) }
                    let planned = WaffledModule.allCases.filter { !$0.isAvailable }
                    if !planned.isEmpty {
                        SectionLabel(text: "Coming soon").padding(.top, 6)
                        ForEach(planned) { comingSoonRow($0) }
                    }
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Modules").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func moduleCard(_ m: WaffledModule) -> some View {
        VStack(spacing: 0) {
            toggleRow(icon: m.icon, title: m.name, sub: m.summary,
                      isOn: isOn(m), busy: saving.contains(m.rawValue)) { setModule(m, $0) }
            // Rewards rides under Chores (its spend half) — only when Chores is on.
            if m == .chores, isOn(.chores) {
                Divider().background(WF.hair).padding(.leading, 52)
                toggleRow(icon: "⭐", title: "Rewards", sub: "Star shop & redemptions — the spend half of chores.",
                          isOn: rewards ?? true, busy: saving.contains("rewards"), indented: true) { setRewards($0) }
            }
        }
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func toggleRow(icon: String, title: String, sub: String, isOn: Bool, busy: Bool,
                           indented: Bool = false, set: @escaping (Bool) -> Void) -> some View {
        HStack(spacing: 12) {
            Text(icon).font(.system(size: 20)).frame(width: 40, height: 40)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Text(sub).font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(get: { isOn }, set: { set($0) }))
                .labelsHidden().tint(WF.primary)
                .disabled(!isAdmin || busy)
        }
        .padding(12).padding(.leading, indented ? 8 : 0)
    }

    private func comingSoonRow(_ m: WaffledModule) -> some View {
        HStack(spacing: 12) {
            Text(m.icon).font(.system(size: 20)).frame(width: 40, height: 40)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                Text(m.summary).font(.system(size: 12)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text("Soon").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                .padding(.horizontal, 8).padding(.vertical, 3).background(WF.panel).clipShape(Capsule())
        }
        .padding(12).background(WF.card).opacity(0.7)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func load() async {
        if let m = try? await api.householdModules() {
            flags = m.modules
            rewards = m.rewards
        }
        loading = false
    }

    /// Optimistic toggle: flip locally, write, adopt the server's merged map, then
    /// reload `sync` so nav/Today react. Revert on failure.
    private func setModule(_ m: WaffledModule, _ on: Bool) {
        let key = m.rawValue
        let prev = flags[key]
        flags[key] = on
        saving.insert(key)
        Task {
            do {
                flags = try await api.setModules([key: on])
                await sync.reloadModules()
            } catch {
                flags[key] = prev
            }
            saving.remove(key)
        }
    }

    private func setRewards(_ on: Bool) {
        let prev = rewards
        rewards = on
        saving.insert("rewards")
        Task {
            do {
                rewards = try await api.setChoresRewards(on)
                await sync.reloadModules()
            } catch {
                rewards = prev
            }
            saving.remove("rewards")
        }
    }
}

// MARK: - Chores & rewards (currencies + conversions)

struct ChoresRewardsSettingsView: View {
    @Environment(SyncManager.self) private var sync
    @State private var currencies: [WaffledAPI.Currency] = []
    @State private var conversions: [WaffledAPI.Conversion] = []
    @State private var loading = true
    @State private var editor: CurrencyEditor?
    // new-conversion form
    @State private var fromKey = ""
    @State private var toKey = ""
    @State private var fromAmt = 10
    @State private var toAmt = 1
    @State private var requireApproval: Bool?   // nil until loaded
    @State private var savingApproval = false
    // Chore photo-proof retention (admin-only) + the "stored photos" manager.
    @State private var proofTtlDays: Int?       // nil until loaded
    @State private var savingTtl = false
    @State private var storedProofs: [WaffledAPI.StoredProof] = []
    @State private var showStoredProofs = false

    private let api = WaffledAPI()

    private var isAdmin: Bool { sync.currentPerson?.isAdmin == true }
    private static let ttlOptions: [(days: Int, label: String)] = [
        (1, "1 day"), (3, "3 days"), (7, "1 week"), (30, "30 days"), (0, "Keep until I delete"),
    ]
    private var ttlLabel: String {
        guard let d = proofTtlDays else { return "…" }
        return Self.ttlOptions.first { $0.days == d }?.label ?? "\(d) days"
    }

    private enum CurrencyEditor: Identifiable {
        case new
        case edit(WaffledAPI.Currency)
        var id: String { if case .edit(let c) = self { return c.id }; return "new" }
        var currency: WaffledAPI.Currency? { if case .edit(let c) = self { return c }; return nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Each group is its own boxed "widget" so it's unmistakable what
                // belongs together: the economy (currencies + their trades)…
                groupTray {
                    currenciesSection
                    if currencies.count > 1 { conversionsSection }
                }
                // …and the separate redemption policy.
                groupTray { approvalsSection }
                // Chore photo-proof retention is an admin setting (the server gates the
                // write), so only surface it to admins — no dead-end for everyone else.
                if isAdmin { groupTray { proofSection } }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("Chores & Rewards").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: sync.rewardsRev) { _, _ in Task { await load() } }
        .sheet(item: $editor) { e in
            CurrencyEditorSheet(editing: e.currency, canDelete: currencies.count > 1) { await load() }
        }
        .sheet(isPresented: $showStoredProofs) {
            StoredProofsSheet(proofs: storedProofs) { await loadProofs() }
        }
    }

    /// A boxed group "widget" — a warm tray that visually binds its contents together
    /// and sets them apart from the next group.
    @ViewBuilder
    private func groupTray<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 18) { content() }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(WF.panel)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private var currenciesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Currencies & trades")
            Text("Rename stars, add your own, or run several. The **default** is what new chores award; **spendable** ones can buy rewards.")
                .font(.system(size: 13)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(currencies) { c in currencyRow(c) }

            Button { editor = .new } label: {
                HStack(spacing: 7) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    Text("Add a currency").font(.system(size: 14, weight: .semibold))
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

    /// Default applied to *new* rewards. Each reward also carries its own approval flag
    /// (edited in the reward sheet), so this is just the starting value. Off → kids redeem
    /// instantly with currency they've earned (a balance guard still applies server-side).
    /// Optimistic toggle, reverts on failure.
    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Reward approvals")
            Text("Sets the default for **new** rewards. On = a parent OKs the purchase; off = the kid redeems instantly with what they’ve earned. Even if off, each reward can have an override to explicitly require approval.")
                .font(.system(size: 13)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 12) {
                Text("✅").font(.system(size: 20)).frame(width: 40, height: 40)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text("New rewards need a parent’s OK by default")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Toggle("", isOn: Binding(
                    get: { requireApproval ?? true },
                    set: { setApproval($0) }))
                    .labelsHidden().tint(WF.primary)
                    .disabled(requireApproval == nil || savingApproval)
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
    }

    /// How long completed-chore photos are kept, plus a way to browse/clear the ones
    /// currently held. The retention write is admin-only (server-gated); the card only
    /// renders for admins. Optimistic select, reverts on failure.
    private var proofSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Chore photo proof")
            Text("When a chore needs a photo, the snapshot is kept this long after it’s done, then deleted automatically. Awaiting check-offs are always kept until you review them.")
                .font(.system(size: 13)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 12) {
                Text("📸").font(.system(size: 20)).frame(width: 40, height: 40)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text("Keep proof photos for")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Menu {
                    ForEach(Self.ttlOptions, id: \.days) { o in
                        Button(o.label) { setProofTtl(o.days) }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(ttlLabel).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                }
                .disabled(proofTtlDays == nil || savingTtl)
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))

            if !storedProofs.isEmpty {
                Button { showStoredProofs = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "photo.stack").font(.system(size: 14, weight: .semibold))
                        Text("View stored photos (\(storedProofs.count))").font(.system(size: 14, weight: .semibold))
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    .foregroundStyle(WF.ink2).padding(12)
                    .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func setProofTtl(_ days: Int) {
        let previous = proofTtlDays
        proofTtlDays = days
        savingTtl = true
        Task {
            do { proofTtlDays = try await api.setProofTtlDays(days) }
            catch { proofTtlDays = previous }   // revert on failure
            savingTtl = false
        }
    }

    private func loadProofs() async {
        storedProofs = (try? await api.storedProofs()) ?? []
    }

    private func setApproval(_ on: Bool) {
        let previous = requireApproval
        requireApproval = on
        savingApproval = true
        Task {
            do { try await api.setRewardApproval(on) }
            catch { requireApproval = previous }   // revert on failure
            savingApproval = false
        }
    }

    private func currencyRow(_ c: WaffledAPI.Currency) -> some View {
        Button { editor = .edit(c) } label: {
            HStack(spacing: 12) {
                Text(c.symbol).font(.system(size: 20)).frame(width: 40, height: 40)
                    .background((Color(hexString: c.color) ?? WF.gold).opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    HStack(spacing: 6) {
                        if c.isDefault { tag("★ Default", WF.gold) }
                        tag(c.spendable ? "Spendable" : "Earn-only", c.spendable ? WF.primary : WF.ink3)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "pencil").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .padding(12).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func tag(_ t: String, _ color: Color) -> some View {
        WaffledStatusBadge(text: t, color: color)
    }

    // MARK: conversions

    private var conversionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // A sub-header (not a full SectionLabel) so it reads as part of the
            // "Currencies & trades" group rather than a peer section.
            Text("Conversions").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
            Text("Let the family trade up a tier — e.g. 10 ⭐ → 1 🥢. Anyone can convert their own balance on the Rewards tab.")
                .font(.system(size: 13)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(conversions) { c in conversionRow(c) }
            addConversionForm
        }
    }

    private func conversionRow(_ c: WaffledAPI.Conversion) -> some View {
        HStack(spacing: 8) {
            Text("\(c.fromAmount) \(c.from.symbol ?? "•") \(c.from.label ?? c.fromCurrency)")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            Text("\(c.toAmount) \(c.to.symbol ?? "•") \(c.to.label ?? c.toCurrency)")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            Spacer(minLength: 0)
            Button { Task { _ = await sync.deleteConversion(id: c.id); await load() } } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private var addConversionForm: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                amountField($fromAmt)
                currencyMenu(selected: $fromKey)
                Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                amountField($toAmt)
                currencyMenu(selected: $toKey)
            }
            Button { Task { await addConversion() } } label: {
                Text("＋ Add rate").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(fromKey == toKey ? WF.ink3 : WF.primary)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(fromKey == toKey || fromKey.isEmpty)
        }
        .padding(12)
        .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        .padding(.top, 2)
    }

    private func amountField(_ value: Binding<Int>) -> some View {
        TextField("0", value: value, format: .number)
            .keyboardType(.numberPad).multilineTextAlignment(.center)
            .font(.system(size: 15, weight: .bold)).frame(width: 44)
            .padding(.vertical, 8).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
    }

    private func currencyMenu(selected: Binding<String>) -> some View {
        let cur = currencies.first { $0.key == selected.wrappedValue }
        return Menu {
            ForEach(currencies) { c in Button("\(c.symbol) \(c.label)") { selected.wrappedValue = c.key } }
        } label: {
            HStack(spacing: 4) {
                Text(cur.map { "\($0.symbol)" } ?? "•").font(.system(size: 15))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
        }
    }

    private func addConversion() async {
        guard fromKey != toKey, !fromKey.isEmpty, !toKey.isEmpty else { return }
        let body: [String: JSONValue] = [
            "fromCurrency": .string(fromKey), "toCurrency": .string(toKey),
            "fromAmount": .int(max(1, fromAmt)), "toAmount": .int(max(1, toAmt)),
        ]
        if await sync.createConversion(body) { fromAmt = 10; toAmt = 1; await load() }
    }

    private func load() async {
        // Make sure we know who's signed in before gating the admin-only proof section,
        // otherwise a slow identity fetch leaves `isAdmin` false and the card never shows.
        await sync.loadIdentity()
        async let cur = api.currencies()
        async let conv = api.conversions()
        async let approval = api.rewardSettings()
        currencies = (try? await cur) ?? []
        conversions = (try? await conv) ?? []
        requireApproval = (try? await approval)?.requireApproval ?? true
        // Photo-proof retention + held photos are an admin-only surface.
        if isAdmin {
            proofTtlDays = (try? await api.choresSettings())?.proofTtlDays ?? 3
            await loadProofs()
        }
        // seed the new-conversion currency pickers
        if fromKey.isEmpty || !currencies.contains(where: { $0.key == fromKey }) { fromKey = currencies.first?.key ?? "" }
        if toKey.isEmpty || !currencies.contains(where: { $0.key == toKey }) {
            toKey = currencies.first(where: { $0.key != fromKey })?.key ?? currencies.first?.key ?? ""
        }
        loading = false
    }
}

struct CurrencyEditorSheet: View {
    let editing: WaffledAPI.Currency?
    let canDelete: Bool
    let onDone: () async -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var label: String
    @State private var symbol: String
    @State private var colorHex: String
    @State private var isDefault: Bool
    @State private var spendable: Bool
    @State private var busy = false
    @State private var confirmDelete = false
    @State private var error: String?

    init(editing: WaffledAPI.Currency?, canDelete: Bool, onDone: @escaping () async -> Void) {
        self.editing = editing
        self.canDelete = canDelete
        self.onDone = onDone
        _label = State(initialValue: editing?.label ?? "")
        _symbol = State(initialValue: editing?.symbol ?? "⭐")
        _colorHex = State(initialValue: editing?.color ?? WaffledSwatch.all[4])   // gold-ish default
        _isDefault = State(initialValue: editing?.isDefault ?? false)
        _spendable = State(initialValue: editing?.spendable ?? true)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 14) {
                        TextField("⭐", text: $symbol)
                            .font(.system(size: 30)).multilineTextAlignment(.center)
                            .frame(width: 64, height: 64).background(WF.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .onChange(of: symbol) { _, v in if v.count > 2 { symbol = String(v.prefix(2)) } }
                        TextField("Stars, Family Dollars…", text: $label)
                            .font(.system(size: 17, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 14)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Color")
                        ColorSwatchPicker(hex: $colorHex)
                    }

                    Toggle(isOn: $isDefault) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Default").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Text("New chores award this").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }.tint(WF.primary)
                    Toggle(isOn: $spendable) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Spendable").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Text("Can buy rewards").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }.tint(WF.primary)

                    if let error { Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary) }

                    Button { Task { await save() } } label: {
                        Text(busy ? "Saving…" : (editing == nil ? "Add currency" : "Save"))
                            .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                            .background(label.trimmingCharacters(in: .whitespaces).isEmpty ? WF.ink3 : WF.primary)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty)

                    if editing != nil, canDelete, !(editing?.isDefault ?? false) {
                        Button(role: .destructive) {
                            if confirmDelete { Task { await remove() } } else { confirmDelete = true }
                        } label: {
                            Text(confirmDelete ? "Tap again to delete" : "Delete currency")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(confirmDelete ? WF.primary : WF.ink3)
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(editing == nil ? "New currency" : "Edit currency")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func payload() -> [String: JSONValue] {
        [
            "label": .string(label.trimmingCharacters(in: .whitespaces)),
            "symbol": symbol.isEmpty ? .null : .string(symbol),
            "color": .string(colorHex),
            "isDefault": .bool(isDefault),
            "spendable": .bool(spendable),
        ]
    }

    private func save() async {
        busy = true; error = nil
        let ok = await sync.saveCurrency(id: editing?.id, payload())
        busy = false
        if ok { await onDone(); dismiss() } else { error = "Couldn’t save. Check your connection." }
    }

    private func remove() async {
        guard let editing else { return }
        busy = true; error = nil
        let ok = await sync.deleteCurrency(id: editing.id)
        busy = false
        if ok { await onDone(); dismiss() }
        else { error = sync.lastError?.contains("default") == true
            ? "Set another currency as default first." : "Couldn’t delete this currency." }
    }
}
