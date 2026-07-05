import SwiftUI
import Observation
import PhotosUI
import UIKit

/// Chores — today's chores grouped by person (plus an "Up for grabs" group for
/// unassigned ones), with a date stepper. Tick to complete/uncomplete; tap an
/// up-for-grabs chore to claim it ("who did it?"); a parent approves/rejects the
/// ones awaiting an OK. Streaks + star rewards shown per row. Online-only.
@MainActor
@Observable
final class ChoresModel {
    private(set) var instances: [WaffledAPI.ChoreInstanceDTO] = []
    private(set) var loading = true
    private(set) var error = false
    /// A dismissible banner shown when a proof upload/complete failed (incl. the 422
    /// "a photo is required" guard) — mirrors web's `proofErr`.
    var proofError: String?
    var date: String

    let api = WaffledAPI()

    init(date: String) { self.date = date }

    func load() async {
        loading = true
        do { instances = try await api.choreInstances(date: date); error = false }
        catch { self.error = true }
        loading = false
    }

    func shift(_ days: Int) async { date = ChoreDates.shift(date, days); await load() }
    func goToday() async { date = ChoreDates.today(); await load() }

    /// Optimistic complete/uncomplete (a chore needing approval lands in "awaiting"),
    /// then reload to pick up the true stars/streak/status.
    func toggle(_ inst: WaffledAPI.ChoreInstanceDTO) async {
        guard let idx = instances.firstIndex(where: { $0.id == inst.id }) else { return }
        let prev = instances[idx].status
        let isComplete = prev == "done" || prev == "awaiting"
        let next = isComplete ? "pending" : (inst.requiresApproval ? "awaiting" : "done")
        withAnimation { instances[idx].status = next }
        do {
            if isComplete { try await api.uncompleteChore(id: inst.id) }
            else { try await api.completeChore(id: inst.id) }
            await load()
        } catch {
            if let i = instances.firstIndex(where: { $0.id == inst.id }) { withAnimation { instances[i].status = prev } }
        }
    }

    /// Assign (or reassign) a chore to a person *without* completing it — the drag-
    /// and-drop gesture (drop into their column). No-op if it's already theirs.
    func assign(id: String, to personId: String) async {
        guard let inst = instances.first(where: { $0.id == id }), inst.personId != personId else { return }
        do { try await api.assignChore(id: id, personId: personId); await load() }
        catch { self.error = true }
    }

    /// Send a chore back to up-for-grabs — dropping it on the "Up for grabs" column.
    /// No-op if it's already unassigned.
    func unassign(id: String) async {
        guard instances.first(where: { $0.id == id })?.personId != nil else { return }
        do { try await api.assignChore(id: id, personId: nil); await load() }
        catch { self.error = true }
    }

    /// Claim an up-for-grabs chore for a person and mark it done in one motion.
    func claimComplete(id: String, personId: String) async {
        do {
            try await api.claimChore(id: id, personId: personId)
            try await api.completeChore(id: id)
            await load()
        } catch { self.error = true }
    }

    /// Finish a photo-required chore with a captured/picked image: upload the blob, then
    /// complete with it (optionally claiming `personId` first for the up-for-grabs path).
    /// Surfaces upload + 422 errors in `proofError` instead of failing silently.
    func completeWithProof(id: String, image: UIImage, claimFor personId: String? = nil) async {
        proofError = nil
        do {
            let up = try await api.uploadImage(image)
            if let personId { try await api.claimChore(id: id, personId: personId) }
            try await api.completeChore(id: id, storageKey: up.key, contentType: up.contentType)
            await load()
        } catch let err as WaffledAPI.APIError where err.isProofRequired {
            proofError = "A photo is required to finish this chore."
        } catch let err as LocalizedError {
            proofError = err.errorDescription ?? "Couldn’t upload that photo — please try again."
        } catch {
            proofError = "Couldn’t upload that photo — please try again."
        }
    }

    func approve(_ id: String) async { do { try await api.approveChore(id: id); await load() } catch { self.error = true } }
    func reject(_ id: String) async { do { try await api.rejectChore(id: id); await load() } catch { self.error = true } }

    /// Create (choreId nil) or edit a chore definition, then reload the day. Returns nil
    /// on success, else a user-facing error message (so the editor can show it instead of
    /// dismissing on a silent failure — e.g. a non-admin hitting the admin-only endpoint).
    func save(choreId: String?, body: [String: JSONValue]) async -> String? {
        do {
            if let choreId { try await api.updateChore(id: choreId, body) }
            else { try await api.createChore(body) }
            await load()
            return nil
        } catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 {
            return "Only a parent can add or edit chores. Switch to a parent to make changes."
        } catch {
            return "Couldn’t save this chore — please try again."
        }
    }

    func delete(choreId: String) async {
        do { try await api.deleteChore(id: choreId); await load() }
        catch { self.error = true }
    }
}

/// Local-date helpers for the day stepper (household runs in device tz here).
enum ChoreDates {
    static func today() -> String { DateFmt.string(Date(), "yyyy-MM-dd", .current) }
    static func shift(_ d: String, _ days: Int) -> String {
        guard let date = DateFmt.date(d, "yyyy-MM-dd", .current),
              let shifted = Calendar.current.date(byAdding: .day, value: days, to: date) else { return d }
        return DateFmt.string(shifted, "yyyy-MM-dd", .current)
    }
    /// (relative label, full label, isToday) for the header.
    static func meta(_ d: String) -> (rel: String, full: String, isToday: Bool) {
        guard let date = DateFmt.date(d, "yyyy-MM-dd", .current) else { return ("", d, true) }
        let cal = Calendar.current
        let diff = cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: date)).day ?? 0
        let rel: String
        switch diff {
        case 0: rel = "Today"
        case 1: rel = "Tomorrow"
        case -1: rel = "Yesterday"
        default: rel = diff > 0 ? "In \(diff) days" : "\(-diff) days ago"
        }
        return (rel, DateFmt.string(date, "EEEE, MMM d", .current), diff == 0)
    }

    /// Client-side "since …" suffix for an overdue one-off (web parity: Tasks.tsx
    /// `overdueLabel`) — its `dueOn` is before the day being viewed. nil when not overdue.
    static func overdueLabel(dueOn: String?, viewing: String) -> String? {
        guard let dueOn,
              let due = DateFmt.date(dueOn, "yyyy-MM-dd", .current),
              let view = DateFmt.date(viewing, "yyyy-MM-dd", .current) else { return nil }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: due), to: cal.startOfDay(for: view)).day ?? 0
        guard days >= 1 else { return nil }
        if days == 1 { return "since yesterday" }
        if days < 7 { return "since \(DateFmt.string(due, "EEE", .current))" }
        return "since \(DateFmt.string(due, "MMM d", .current))"
    }
}

/// A person's (or the up-for-grabs) column of chores for the day.
struct ChoreColumn: Identifiable {
    let id: String
    let name: String
    let emoji: String?
    let colorHex: String?
    let isGrabs: Bool
    let items: [WaffledAPI.ChoreInstanceDTO]
    var done: Int { items.filter { $0.status == "done" }.count }
}

struct ChoresView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model = ChoresModel(date: ChoreDates.today())
    @State private var approvals = ApprovalsModel()   // parent "needs your OK" banner
    @State private var claiming: String?   // instance id whose "who did it?" picker is open
    @State private var editor: ChoreEditorTarget?
    @State private var collapsed: Set<String> = []   // column ids the user has folded
    @State private var dropTarget: String?           // person column id currently under a drag

    // Photo-proof capture: the instance (and optional person to claim first) we're
    // capturing for, which picker is presented, and a parent's open proof review.
    @State private var proofTarget: ProofTarget?     // which chore we're capturing proof for
    @State private var showProofChoice = false       // the Take Photo / Library dialog is up
    @State private var showCamera = false            // camera sheet presented
    @State private var libraryPick: PhotosPickerItem?// PhotosPicker selection token
    @State private var reviewing: WaffledAPI.ChoreInstanceDTO?  // parent's proof review sheet
    @State private var proofPreview: ProofPreview?   // captured photo awaiting "Use / Retake"

    /// A chore awaiting a photo, plus the person to claim it for first (up-for-grabs).
    struct ProofTarget: Identifiable {
        let inst: WaffledAPI.ChoreInstanceDTO
        let claimFor: String?
        var id: String { inst.id }
    }

    /// A freshly-captured proof photo held for the confirm step (before it uploads).
    struct ProofPreview: Identifiable {
        let image: UIImage
        let target: ProofTarget
        var id: String { target.id }
    }

    /// What the chore editor sheet is editing/creating.
    enum ChoreEditorTarget: Identifiable {
        case new(personId: String?)
        case edit(WaffledAPI.ChoreInstanceDTO)
        var id: String {
            switch self {
            case let .new(pid): return "new:\(pid ?? "")"
            case let .edit(i): return "edit:\(i.id)"
            }
        }
    }

    /// iPad lays the person columns side-by-side (web-like Kanban); iPhone stacks them.
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        Group {
            if isKiosk { kioskContent } else { phoneContent }
        }
        .background(WF.canvas)
        .navigationTitle("Chores")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isKiosk ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editor = .new(personId: nil) } label: {
                    Label("New chore", systemImage: "plus").labelStyle(.titleAndIcon).fontWeight(.semibold)
                }
            }
        }
        .task(id: sync.choresRev) { await model.load(); await approvals.load() }
        .task { await sync.loadCurrencies() }
        .sheet(item: $editor) { target in
            // Snapshot the sync-derived inputs HERE (read `sync` once) instead of letting
            // the sheet observe SyncManager — see ChoreEditSheet for why that hung the UI.
            // Managers can assign to anyone; everyone else only to themselves (web parity).
            let assignable = sync.can("chore.manage")
                ? sync.members
                : sync.members.filter { $0.id == sync.currentPersonId }
            ChoreEditSheet(assignableMembers: assignable, currencies: sync.currencies, target: target,
                onSave: { choreId, body in await model.save(choreId: choreId, body: body) },
                onDelete: { choreId in Task { await model.delete(choreId: choreId) } })
        }
        // ── Photo-proof capture ──────────────────────────────────────────────
        // Tapping the tick of a photo-required chore opens this Take Photo / Library
        // choice; Take Photo is hidden when there's no camera (simulator/iPad).
        .confirmationDialog("Add a photo to finish this chore",
                            isPresented: $showProofChoice, titleVisibility: .visible,
                            presenting: proofTarget) { _ in
            // Picking an option closes the dialog explicitly and hands off to a picker;
            // proofTarget stays set so the picker callback knows which chore it's for.
            // (Driving this off an explicit flag — not "is a picker open?" — avoids the
            // dialog re-triggering when the photo picker dismisses itself.)
            if ProofCapture.cameraAvailable {
                Button("Take Photo") { showProofChoice = false; showCamera = true }
            }
            Button("Choose from Library") { showProofChoice = false; presentLibrary() }
            Button("Cancel", role: .cancel) { showProofChoice = false; proofTarget = nil }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in onProofImage(image) }
                .ignoresSafeArea()
        }
        .photosPicker(isPresented: photosPickerBinding, selection: $libraryPick, matching: .images)
        .onChange(of: libraryPick) { _, item in Task { await loadLibraryPick(item) } }
        .sheet(item: $reviewing) { c in
            let m = c.personId.flatMap { id in sync.members.first { $0.id == id } }
            ChoreProofReview(
                chore: c, memberColorHex: m?.colorHex,
                coin: c.rewardAmount > 0 ? "\(c.rewardAmount)\(sync.currencySymbol(c.rewardCurrency))" : nil,
                canDecide: sync.can("chore.approve") && c.status == "awaiting",
                onApprove: { decide(c) { await sync.approveChore(id: c.id) } },
                onReject: { decide(c) { await sync.rejectChore(id: c.id) } })
        }
        // Confirm a freshly-captured photo before it uploads — so an accidental library
        // tap (or a blurry shot) doesn't silently finish the chore.
        .sheet(item: $proofPreview) { preview in
            let inst = preview.target.inst
            ChoreProofConfirm(
                image: preview.image, chore: inst,
                coin: inst.rewardAmount > 0 ? "\(inst.rewardAmount)\(sync.currencySymbol(inst.rewardCurrency))" : nil,
                onUse: { submitProof(preview) },
                onRetake: { retakeProof(preview.target) })
        }
    }

    // MARK: photo-proof capture plumbing

    @State private var photosPickerOpen = false
    private var photosPickerBinding: Binding<Bool> {
        Binding(get: { photosPickerOpen }, set: { photosPickerOpen = $0 })
    }

    /// Begin capture for a chore (called from the tick) — opens the choice dialog.
    private func startProof(_ inst: WaffledAPI.ChoreInstanceDTO, claimFor personId: String? = nil) {
        model.proofError = nil
        proofTarget = ProofTarget(inst: inst, claimFor: personId)
        showProofChoice = true
    }
    private func presentLibrary() { photosPickerOpen = true }

    /// A camera image was captured: preview it for confirmation (don't submit yet).
    private func onProofImage(_ image: UIImage) {
        showCamera = false
        guard let target = proofTarget else { return }
        proofTarget = nil
        proofPreview = ProofPreview(image: image, target: target)
    }

    /// A library item was picked: load it to a UIImage, then preview for confirmation.
    private func loadLibraryPick(_ item: PhotosPickerItem?) async {
        photosPickerOpen = false
        defer { libraryPick = nil }
        guard let item, let target = proofTarget else { proofTarget = nil; return }
        proofTarget = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                model.proofError = "Couldn’t read that photo — please try another."
                return
            }
            proofPreview = ProofPreview(image: image, target: target)
        } catch {
            model.proofError = "Couldn’t read that photo — please try another."
        }
    }

    /// Confirmed: upload the previewed photo and finish the chore.
    private func submitProof(_ preview: ProofPreview) {
        proofPreview = nil
        Task {
            await model.completeWithProof(id: preview.target.inst.id, image: preview.image, claimFor: preview.target.claimFor)
            sync.bumpChores()
        }
    }

    /// "Retake": drop the previewed photo and reopen the Take Photo / Library choice.
    private func retakeProof(_ target: ProofTarget) {
        proofPreview = nil
        proofTarget = target
        // Re-present the choice after the confirm sheet finishes dismissing (presenting a
        // confirmationDialog mid-dismiss otherwise no-ops).
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            showProofChoice = true
        }
    }

    // MARK: iPhone — vertical stack of columns

    private var phoneContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                proofErrorBanner
                approvalsCard
                dateNav
                if model.loading && model.instances.isEmpty {
                    WaffledLoading(top: 32)
                } else if model.instances.isEmpty {
                    WaffledEmptyState(
                        emoji: model.error ? "😕" : "✅",
                        title: model.error ? "Couldn’t load chores"
                                           : "Nothing scheduled \(ChoreDates.meta(model.date).isToday ? "today" : "this day")",
                        message: model.error ? "Pull to refresh to try again." : nil,
                        top: 32)
                }
                ForEach(columns) { col in columnCard(col) }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 110)
        }
        // Bounce even when nothing's scheduled, so pull-to-refresh still triggers.
        .scrollBounceBehavior(.always)
        .refreshable { await model.load(); await approvals.load() }
    }

    // MARK: iPad — side-by-side Kanban columns

    private var kioskContent: some View {
        VStack(spacing: 14) {
            KioskPageHeader("Chores", "Tick one off — or drag a chore to whoever did it.") {
                KioskHeaderButton(icon: "plus", label: "New chore") { editor = .new(personId: nil) }
            }
            proofErrorBanner.frame(maxWidth: 760)
            if sync.can("chore.approve") && !approvals.chores.isEmpty { approvalsCard.frame(maxWidth: 760) }
            dateNav.frame(maxWidth: 440)
            if model.loading && model.instances.isEmpty {
                WaffledLoading(top: 32); Spacer()
            } else {
                // Columns keep a minimum width and wrap onto new rows; the board scrolls.
                ScrollView(showsIndicators: false) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240, maximum: 380), spacing: 14, alignment: .top)],
                              alignment: .leading, spacing: 14) {
                        ForEach(columns) { col in kioskColumn(col) }
                    }
                    .padding(.bottom, 20)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// One always-open column (content-sized; the board wraps + scrolls). Reuses the
    /// shared row/drag/claim logic + drop target.
    private func kioskColumn(_ col: ChoreColumn) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                if col.isGrabs {
                    Text("🙌").font(.system(size: 16)).frame(width: 32, height: 32)
                        .background(WF.gold.opacity(0.15)).clipShape(Circle())
                } else {
                    Avatar(colorHex: col.colorHex, emoji: col.emoji ?? "🙂", size: 32)
                }
                Text(col.name).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 4)
                let allDone = !col.items.isEmpty && col.done == col.items.count
                HStack(spacing: 3) {
                    Image(systemName: allDone ? "checkmark.circle.fill" : "checkmark.circle")
                        .font(.system(size: 12)).foregroundStyle(allDone ? FamilyColor.wally.solid : WF.ink3)
                    Text("\(col.done)/\(col.items.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                }
            }
            .padding(.bottom, 10)
            Rectangle().fill(WF.hair).frame(height: 1)
            // Capped height + internal scroll, so a long list stays put instead of
            // pushing the columns below it down the page.
            ScrollView(showsIndicators: false) {
                // Lazy: only on-screen rows build their (heavy) drag previews + drop
                // wiring; an eager VStack rebuilt the whole board's draggable rows on
                // every ChoresView.body pass (e.g. when a sheet was presented over it).
                LazyVStack(spacing: 0) {
                    if col.isGrabs && !col.items.isEmpty {
                        Text("Tap to claim it, or drag it into someone’s column.")
                            .font(.system(size: 11.5, weight: .medium)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8).padding(.bottom, 2)
                    }
                    ForEach(Array(col.items.enumerated()), id: \.element.id) { i, inst in
                        draggableRow(choreRow(inst, isGrabs: col.isGrabs), inst: inst)
                        if i < col.items.count - 1 { Divider().background(WF.hair) }
                    }
                    if col.items.isEmpty {
                        Text(col.isGrabs ? "Nothing up for grabs." : "Nothing for \(col.name).")
                            .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
                    }
                    // Assigning a chore to someone else is manage-only; anyone can still
                    // add one to "Up for grabs" (the self-serve carve-out, like the web).
                    if col.isGrabs || sync.can("chore.manage") {
                        Button { editor = .new(personId: col.isGrabs ? nil : col.id) } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                                Text("Add chore").font(.system(size: 13, weight: .semibold))
                            }
                            .foregroundStyle(WF.ink3).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .frame(height: 460)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(dropTarget == col.id ? WF.primary
                          : (col.isGrabs ? WF.gold.opacity(0.4) : WF.hair),
                          lineWidth: dropTarget == col.id ? 2 : 1))
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            dropTarget = nil
            if col.isGrabs { Task { await model.unassign(id: id) } }
            else { Task { await model.assign(id: id, to: col.id) } }
            return true
        } isTargeted: { hovering in
            withAnimation(.easeInOut(duration: 0.12)) {
                dropTarget = hovering ? col.id : (dropTarget == col.id ? nil : dropTarget)
            }
        }
    }

    /// A dismissible inline error for a failed photo upload / the 422 "needs a photo"
    /// guard — mirrors web's `proofErr` banner.
    @ViewBuilder
    private var proofErrorBanner: some View {
        if let msg = model.proofError {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 15)).foregroundStyle(WF.primary)
                Text(msg).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink)
                Spacer(minLength: 6)
                Button { withAnimation { model.proofError = nil } } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            }
            .padding(12)
            .background(WF.primary.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.primary.opacity(0.3), lineWidth: 1))
        }
    }

    // MARK: inline approvals ("Needs your OK")

    /// Chore check-offs waiting on a parent, surfaced inline at the top so you can
    /// Approve/Reject in place — no extra screen. Mirrors the Rewards tab's card, but
    /// scoped to chores (reward purchases live on Today/Rewards). Pulls all awaiting
    /// instances across dates, so it's independent of the day you're viewing.
    @ViewBuilder
    private var approvalsCard: some View {
        if sync.can("chore.approve") && !approvals.chores.isEmpty {
            WaffledCard(padding: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 6) {
                        Text("Needs your OK").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text("\(approvals.chores.count)").font(.system(size: 12, weight: .heavy)).foregroundStyle(WF.primary)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(WF.primary.opacity(0.12)).clipShape(Capsule())
                    }
                    ForEach(Array(approvals.chores.enumerated()), id: \.element.id) { idx, c in
                        if idx > 0 { Divider().background(WF.hair) }
                        approvalRow(c)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func approvalRow(_ c: WaffledAPI.ChoreInstanceDTO) -> some View {
        let m = c.personId.flatMap { id in sync.members.first { $0.id == id } }
        if isKiosk {
            // Compact single line on iPad — full-width buttons read as excessive there.
            HStack(spacing: 12) {
                Avatar(colorHex: m?.colorHex, emoji: m?.emoji ?? "🙂", size: 34)
                approvalText(c)
                Spacer(minLength: 8)
                ChoreProofThumb(chore: c) { reviewing = c }
                ApprovalActionPair(
                    denyLabel: "Not yet", isKiosk: true,
                    onDeny: { decide(c) { await sync.rejectChore(id: c.id) } },
                    onApprove: { decide(c) { await sync.approveChore(id: c.id) } }
                )
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Avatar(colorHex: m?.colorHex, emoji: m?.emoji ?? "🙂", size: 36)
                    approvalText(c)
                    Spacer(minLength: 0)
                    ChoreProofThumb(chore: c) { reviewing = c }
                }
                ApprovalActionPair(
                    denyLabel: "Not yet", isKiosk: false,
                    onDeny: { decide(c) { await sync.rejectChore(id: c.id) } },
                    onApprove: { decide(c) { await sync.approveChore(id: c.id) } }
                )
            }
        }
    }

    private func approvalText(_ c: WaffledAPI.ChoreInstanceDTO) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(c.personName ?? "Someone") finished")
                .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
            HStack(spacing: 6) {
                Text("\(c.emoji ?? "🧹") \(c.choreTitle)")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                if c.rewardAmount > 0 {
                    Text("\(c.rewardAmount)\(sync.currencySymbol(c.rewardCurrency))")
                        .font(.system(size: 12.5, weight: .heavy)).foregroundStyle(WF.gold)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(WF.gold.opacity(0.14)).clipShape(Capsule())
                }
            }
        }
    }

    /// Optimistically drop the row, run the decision, then refresh both the queue and
    /// the columns (approve moves the chore to done, reject sends it back to pending).
    private func decide(_ c: WaffledAPI.ChoreInstanceDTO, _ op: @escaping () async -> Bool) {
        approvals.drop(chore: c.id)
        Task {
            let ok = await op()
            await approvals.load()
            if ok { await model.load() }
        }
    }

    /// Up for grabs first, then every household member in order, then any orphans.
    private var columns: [ChoreColumn] {
        var byPerson: [String: [WaffledAPI.ChoreInstanceDTO]] = [:]
        var grabs: [WaffledAPI.ChoreInstanceDTO] = []
        for i in model.instances {
            if let pid = i.personId { byPerson[pid, default: []].append(i) } else { grabs.append(i) }
        }
        // Up for grabs always leads (even when empty), so anyone-can-claim chores
        // have a home to add to — matching the web board.
        var cols: [ChoreColumn] = [
            ChoreColumn(id: "__grabs__", name: "Up for grabs", emoji: "🙌", colorHex: nil, isGrabs: true, items: grabs),
        ]
        var seen = Set<String>()
        for m in sync.members {
            seen.insert(m.id)
            cols.append(ChoreColumn(id: m.id, name: m.name, emoji: m.emoji, colorHex: m.colorHex, isGrabs: false, items: byPerson[m.id] ?? []))
        }
        for (pid, items) in byPerson where !seen.contains(pid) {
            cols.append(ChoreColumn(id: pid, name: items.first?.personName ?? "Someone", emoji: nil, colorHex: nil, isGrabs: false, items: items))
        }
        return cols
    }

    private var dateNav: some View {
        let meta = ChoreDates.meta(model.date)
        return VStack(spacing: 8) {
            HStack(spacing: 12) {
                Button { Task { await model.shift(-1) } } label: { navArrow("chevron.left") }
                VStack(spacing: 1) {
                    Text(meta.full).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(meta.rel).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                .frame(maxWidth: .infinity)
                Button { Task { await model.shift(1) } } label: { navArrow("chevron.right") }
            }
            if !meta.isToday {
                Button { Task { await model.goToday() } } label: {
                    Text("Jump to today").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.primary)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(WF.primary.opacity(0.1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func navArrow(_ system: String) -> some View {
        Image(systemName: system).font(.system(size: 14, weight: .heavy)).foregroundStyle(WF.ink2)
            .frame(width: 38, height: 38).background(WF.panel).clipShape(Circle())
    }

    private func columnCard(_ col: ChoreColumn) -> some View {
        let isCollapsed = collapsed.contains(col.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isCollapsed { collapsed.remove(col.id) } else { collapsed.insert(col.id) }
                }
            } label: {
                HStack(spacing: 9) {
                    if col.isGrabs {
                        Text("🙌").font(.system(size: 16)).frame(width: 30, height: 30)
                            .background(WF.gold.opacity(0.15)).clipShape(Circle())
                    } else {
                        Avatar(colorHex: col.colorHex, emoji: col.emoji ?? "🙂", size: 30)
                    }
                    Text(col.name).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Spacer()
                    let allDone = !col.items.isEmpty && col.done == col.items.count
                    HStack(spacing: 3) {
                        Image(systemName: allDone ? "checkmark.circle.fill" : "checkmark.circle")
                            .font(.system(size: 12)).foregroundStyle(allDone ? FamilyColor.wally.solid : WF.ink3)
                        Text("\(col.done)/\(col.items.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                    }
                    DisclosureChevron(isOpen: !isCollapsed)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !isCollapsed {
                if col.isGrabs && !col.items.isEmpty {
                    Text("Tap to claim it, or drag it into someone’s column to assign it.")
                        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(WF.ink3)
                        .padding(.top, 4).padding(.bottom, 2)
                }
                VStack(spacing: 0) {
                    ForEach(Array(col.items.enumerated()), id: \.element.id) { i, inst in
                        draggableRow(choreRow(inst, isGrabs: col.isGrabs), inst: inst)
                        if i < col.items.count - 1 { Divider().background(WF.hair) }
                    }
                }
                .padding(.top, 4)
                if col.items.isEmpty {
                    Text(col.isGrabs ? "Nothing up for grabs — add one anyone can claim."
                                     : "Nothing for \(col.name) \(ChoreDates.meta(model.date).isToday ? "today" : "this day").")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3).padding(.vertical, 6)
                }
                if col.isGrabs || sync.can("chore.manage") {
                    Button { editor = .new(personId: col.isGrabs ? nil : col.id) } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "plus").font(.system(size: 11, weight: .heavy))
                            Text("Add chore").font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(WF.ink3).padding(.top, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(dropTarget == col.id ? WF.primary
                          : (col.isGrabs ? WF.gold.opacity(0.4) : WF.hair),
                          lineWidth: dropTarget == col.id ? 2 : 1))
        // Drop a chore here to (re)assign it to this person, or onto "Up for grabs"
        // to unassign it.
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first else { return false }
            dropTarget = nil
            if col.isGrabs { Task { await model.unassign(id: id) } }
            else { Task { await model.assign(id: id, to: col.id) } }
            return true
        } isTargeted: { hovering in
            withAnimation(.easeInOut(duration: 0.12)) {
                dropTarget = hovering ? col.id : (dropTarget == col.id ? nil : dropTarget)
            }
        }
    }

    /// Wrap a chore row so it can be dragged between columns — reassign to a person,
    /// or back to up-for-grabs. Only still-pending chores are draggable (a done or
    /// awaiting one keeps its awarded stars where they are).
    @ViewBuilder private func draggableRow(_ row: some View, inst: WaffledAPI.ChoreInstanceDTO) -> some View {
        // Dragging reassigns a chore to another column — a manage-only action, so only
        // make rows draggable when the signed-in person can manage chores.
        if inst.status == "pending" && sync.can("chore.manage") {
            // contentShape makes the *whole* row (incl. the trailing empty space)
            // the drag handle, not just the title text.
            row.contentShape(Rectangle()).draggable(inst.id) {
                HStack(spacing: 6) {
                    Text(inst.emoji ?? "🧹").font(.system(size: 14))
                    Text(inst.choreTitle).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(WF.card)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(WF.gold.opacity(0.5), lineWidth: 1))
            }
        } else {
            row
        }
    }

    @ViewBuilder private func choreRow(_ inst: WaffledAPI.ChoreInstanceDTO, isGrabs: Bool) -> some View {
        let isDone = inst.status == "done"
        let isAwaiting = inst.status == "awaiting"
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                Button {
                    if isGrabs { withAnimation { claiming = claiming == inst.id ? nil : inst.id } }
                    // A photo-required chore that isn't yet complete must capture a photo
                    // before it can finish — open the picker instead of toggling.
                    else if inst.requiresPhoto && !isDone && !isAwaiting { startProof(inst) }
                    // Completing an approval-required chore creates an awaiting item.
                    // Bump choresRev so this tab's "Needs your OK" card (a separate model)
                    // and the Today tab / badge all reload — not just the day's columns.
                    else { Task { await model.toggle(inst); sync.bumpChores() } }
                } label: { tick(isDone: isDone, isAwaiting: isAwaiting, isGrabs: isGrabs,
                                 needsPhoto: inst.requiresPhoto && !isDone && !isAwaiting) }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(inst.emoji.map { "\($0) " } ?? "")\(inst.choreTitle)")
                            .font(.system(size: 15, weight: .semibold))
                            .strikethrough(isDone, color: WF.ink3)
                            .foregroundStyle(isDone ? WF.ink3 : WF.ink).lineLimit(1)
                        if inst.streak >= 2 {
                            Text("🔥 \(inst.streak)").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                        // Carried-forward one-off: red "overdue · since …" pill (web parity).
                        if !isDone, !isAwaiting,
                           let since = ChoreDates.overdueLabel(dueOn: inst.dueOn, viewing: model.date) {
                            Text("overdue · \(since)")
                                .font(.system(size: 10.5, weight: .heavy))
                                .foregroundStyle(WF.primaryD)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(WF.primary.opacity(0.12)).clipShape(Capsule())
                                .lineLimit(1)
                        }
                    }
                    HStack(spacing: 5) {
                        Text(sync.currencySymbol(inst.rewardCurrency)).font(.system(size: 11))
                        Text("\(inst.rewardAmount)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        if isAwaiting {
                            Text("Needs OK").font(.system(size: 10, weight: .heavy))
                                .foregroundStyle(WF.primary)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(WF.primary.opacity(0.12)).clipShape(Capsule())
                        }
                    }
                }
                Spacer(minLength: 6)
                // The submitted photo (if any), on awaiting AND done chores — so the kid
                // sees their proof is attached and anyone (esp. a parent) can tap to view
                // it big, even when the chore didn't need a separate approval step.
                if isAwaiting || isDone {
                    ChoreProofThumb(chore: inst) { reviewing = inst }
                }
            }
            .padding(.top, 9)
            .padding(.bottom, isAwaiting && sync.can("chore.approve") ? 4 : 9)
            // Tap anywhere on the row to edit — the tick and approve/reject Buttons
            // intercept their own taps, so they're unaffected. Editing a chore's
            // definition is manage-only; without it, tapping is a no-op (no dead-end).
            .contentShape(Rectangle())
            .onTapGesture { if sync.can("chore.manage") { editor = .edit(inst) } }

            // Approve/Reject go on their own line beneath the row (both phone and iPad),
            // so the top row stays icon · title · photo instead of cramming everything in
            // until the button labels wrap.
            if isAwaiting && sync.can("chore.approve") {
                approvalButtons(inst)
                    .padding(.bottom, 9)
            }

            if isGrabs && claiming == inst.id { claimPicker(inst) }
        }
    }

    /// The Reject / Approve pair for an awaiting chore, shown on its own line beneath the
    /// row (both phone and iPad). Bumps choresRev so the Today tab + badge reflect it too.
    private func approvalButtons(_ inst: WaffledAPI.ChoreInstanceDTO) -> some View {
        // Each button fills half the row — bigger, easier tap targets that read as the
        // row's primary action rather than two small trailing pills.
        HStack(spacing: 10) {
            Button { Task { await model.reject(inst.id); sync.bumpChores() } } label: {
                Text("Reject").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1.5))
            }.buttonStyle(.plain)
            Button { Task { await model.approve(inst.id); sync.bumpChores() } } label: {
                Text("Approve").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(FamilyColor.wally.solid).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
    }

    private func tick(isDone: Bool, isAwaiting: Bool, isGrabs: Bool, needsPhoto: Bool = false) -> some View {
        Group {
            if isAwaiting {
                Text("⏳").font(.system(size: 16)).frame(width: 26, height: 26)
            } else if isDone {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(FamilyColor.wally.solid)
            } else if needsPhoto && !isGrabs {
                // 📷 affordance, matching web: a photo-required chore shows the camera
                // on its incomplete tick so it's clear a snapshot is needed to finish.
                Image(systemName: "camera.circle").font(.system(size: 22)).foregroundStyle(WF.primary)
            } else {
                Image(systemName: isGrabs ? "hand.raised.circle" : "circle").font(.system(size: 22))
                    .foregroundStyle(isGrabs ? WF.gold : WF.ink3)
            }
        }
        .frame(width: 30, height: 30).contentShape(Rectangle())
    }

    private func claimPicker(_ inst: WaffledAPI.ChoreInstanceDTO) -> some View {
        HStack(spacing: 8) {
            Text("Who did it?").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
            ForEach(sync.members) { m in
                Button {
                    claiming = nil
                    // Photo-required up-for-grabs: capture the proof first, then claim +
                    // complete with it; otherwise claim + complete straight away.
                    if inst.requiresPhoto { startProof(inst, claimFor: m.id) }
                    else { Task { await model.claimComplete(id: inst.id, personId: m.id); sync.bumpChores() } }
                } label: {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 30)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            Button { withAnimation { claiming = nil } } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
            }.buttonStyle(.plain)
        }
        .padding(.vertical, 8).padding(.horizontal, 4)
    }
}

/// Create or edit a chore definition — title, emoji, repeat schedule (every day /
/// certain weekdays), who (or up-for-grabs), star reward, and a parent-approval
/// toggle. Delete when editing. Mirrors the web ChoreModal. WF-styled.
struct ChoreEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    /// Snapshotted by the presenter from SyncManager so the sheet does NOT observe the
    /// whole @Observable sync object — observing it re-evaluated/re-laid-out the sheet's
    /// body (segmented Picker + chip flows) on every unrelated sync mutation, which on a
    /// real iPad stacked into a multi-second hang when presented over the chores board.
    let assignableMembers: [SyncedMember]
    /// The household's reward currencies, likewise snapshotted (was `sync.currencies`).
    let currencies: [WaffledAPI.Currency]
    let target: ChoresView.ChoreEditorTarget
    /// Persist the chore. Returns nil on success, else a user-facing error message
    /// (so the sheet stays open and shows why, instead of dismissing on a silent fail).
    let onSave: (String?, [String: JSONValue]) async -> String?
    let onDelete: (String) -> Void

    private static let days: [(code: String, label: String)] = [
        ("MO", "Mon"), ("TU", "Tue"), ("WE", "Wed"), ("TH", "Thu"), ("FR", "Fri"), ("SA", "Sat"), ("SU", "Sun"),
    ]

    private let editChoreId: String?
    @State private var title: String
    @State private var emoji: String
    @State private var personId: String?
    @State private var stars: Int
    /// Chosen reward currency key; nil = the household default.
    @State private var currencyKey: String?
    @State private var freq: String        // "once" | "daily" | "weekly"
    @State private var days: Set<String>
    @State private var dueOn: Date         // the "On" date for a one-off ("Just once")
    @State private var requiresApproval: Bool
    @State private var requiresPhoto: Bool
    @State private var confirmDelete = false
    @State private var saving = false
    @State private var saveError: String?
    @FocusState private var titleFocused: Bool

    init(assignableMembers: [SyncedMember], currencies: [WaffledAPI.Currency],
         target: ChoresView.ChoreEditorTarget,
         onSave: @escaping (String?, [String: JSONValue]) async -> String?, onDelete: @escaping (String) -> Void) {
        self.assignableMembers = assignableMembers; self.currencies = currencies
        self.target = target; self.onSave = onSave; self.onDelete = onDelete
        switch target {
        case let .new(pid):
            editChoreId = nil
            _title = State(initialValue: ""); _emoji = State(initialValue: "")
            _personId = State(initialValue: pid); _stars = State(initialValue: 1)
            _currencyKey = State(initialValue: nil)
            _freq = State(initialValue: "daily"); _days = State(initialValue: [])
            _dueOn = State(initialValue: Date())
            _requiresApproval = State(initialValue: false)
            _requiresPhoto = State(initialValue: false)
        case let .edit(i):
            editChoreId = i.choreId
            _title = State(initialValue: i.choreTitle); _emoji = State(initialValue: i.emoji ?? "")
            _personId = State(initialValue: i.personId); _stars = State(initialValue: i.rewardAmount)
            _currencyKey = State(initialValue: i.rewardCurrency)
            let parsed = ChoreEditSheet.parseRrule(i.rrule)
            _freq = State(initialValue: parsed.freq); _days = State(initialValue: Set(parsed.days))
            _dueOn = State(initialValue: DateFmt.date(i.dueOn ?? "", "yyyy-MM-dd", .current) ?? Date())
            _requiresApproval = State(initialValue: i.requiresApproval)
            _requiresPhoto = State(initialValue: i.requiresPhoto)
        }
    }

    private var editing: Bool { editChoreId != nil }
    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty && (freq != "weekly" || !days.isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let saveError {
                        Text(saveError)
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(WF.primary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    }
                    HStack(spacing: 12) {
                        labeled("Title") {
                            TextField("Feed the dog", text: $title)
                                .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.sentences)
                                .focused($titleFocused)
                                .padding(.horizontal, 13).padding(.vertical, 12).cardField()
                        }
                        labeled("Emoji", width: 64) {
                            TextField("🐶", text: $emoji).multilineTextAlignment(.center)
                                .font(.system(size: 16, weight: .semibold)).frame(width: 60).padding(.vertical, 12).cardField()
                                .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Repeats")
                        // Plain binding (NOT `$freq.animation()`): an animated binding installs
                        // an animation transaction on the segmented control's every layout,
                        // which collides with the keyboard-driven ScrollView resize when the
                        // title auto-focuses. The animation is scoped to the rows below instead.
                        Picker("Repeats", selection: $freq) {
                            Text("Just once").tag("once")
                            Text("Every day").tag("daily")
                            Text("Certain days").tag("weekly")
                        }
                        .pickerStyle(.segmented)
                        // One-off: pick the day it's due (shown for both new and edit — an
                        // edit moves the chore's single pending instance). No min, so an
                        // overdue one-off can be re-dated forward or back.
                        if freq == "once" {
                            DatePicker("On", selection: $dueOn, displayedComponents: .date)
                                .font(.system(size: 15, weight: .semibold))
                                .tint(WF.primary)
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        }
                        if freq == "weekly" {
                            HStack(spacing: 5) {
                                ForEach(Self.days, id: \.code) { d in
                                    let on = days.contains(d.code)
                                    Button { if on { days.remove(d.code) } else { days.insert(d.code) } } label: {
                                        Text(d.label).font(.system(size: 12, weight: .bold))
                                            .foregroundStyle(on ? .white : WF.ink2)
                                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                                            .background(on ? WF.primary : WF.card)
                                            .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(on ? Color.clear : WF.hair, lineWidth: 1))
                                            .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .transition(.opacity.combined(with: .move(edge: .top)))
                        }
                    }
                    .animation(.easeInOut(duration: 0.2), value: freq)

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Who")
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            personChip(nil, label: "🙌 Up for grabs")
                            ForEach(assignableMembers) { m in personChip(m.id, label: "\(m.emoji ?? "🙂") \(goalFirstName(m.name))") }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        if currencies.count > 1 {
                            VStack(alignment: .leading, spacing: 9) {
                                SectionLabel(text: "Reward")
                                ChipFlow(spacing: 8, lineSpacing: 8) {
                                    ForEach(currencies) { c in
                                        let on = c.key == effectiveCurrencyKey
                                        let tint = Color(hexString: c.color) ?? WF.gold
                                        Button { currencyKey = c.key } label: {
                                            Text("\(c.symbol) \(c.label)")
                                                .font(.system(size: 14, weight: on ? .bold : .medium))
                                                .foregroundStyle(on ? WF.ink : WF.ink2)
                                                .padding(.horizontal, 13).padding(.vertical, 8)
                                                .background(on ? tint.opacity(0.16) : WF.panel)
                                                .clipShape(Capsule())
                                                .overlay(Capsule().strokeBorder(on ? tint.opacity(0.5) : .clear, lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        HStack {
                            SectionLabel(text: currencies.count > 1 ? "Amount" : "Stars")
                            Spacer()
                            HStack(spacing: 14) {
                                Button { if stars > 0 { stars -= 1 } } label: {
                                    Image(systemName: "minus.circle.fill").font(.system(size: 24)).foregroundStyle(stars > 0 ? WF.ink2 : WF.hair)
                                }.buttonStyle(.plain).disabled(stars == 0)
                                HStack(spacing: 3) {
                                    rewardSymbol
                                    Text("\(stars)").font(.system(size: 17, weight: .heavy)).foregroundStyle(WF.ink).frame(minWidth: 20)
                                }
                                Button { stars += 1 } label: {
                                    Image(systemName: "plus.circle.fill").font(.system(size: 24)).foregroundStyle(WF.primary)
                                }.buttonStyle(.plain)
                            }
                        }
                    }

                    Toggle(isOn: $requiresApproval) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Needs a parent’s OK").font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            Text("The reward is awarded only after a parent approves.")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(13).cardField()

                    Toggle(isOn: $requiresPhoto) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Needs a photo").font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            Text("A snapshot of the finished job is needed to complete it.")
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                    .tint(FamilyColor.wally.solid)
                    .padding(13).cardField()

                    // A photo on its own attaches to the finished chore but doesn't pause
                    // for review. Nudge toward pairing it with approval so the photo lands
                    // in your "Needs your OK" queue before the reward counts.
                    if requiresPhoto && !requiresApproval {
                        Label("Turn on “Needs a parent’s OK” too if you want to see the photo in your approvals before it counts.",
                              systemImage: "info.circle.fill")
                            .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 4)
                    }

                    if editing {
                        Button {
                            if confirmDelete { onDelete(editChoreId!); dismiss() }
                            else { withAnimation { confirmDelete = true } }
                        } label: {
                            Text(confirmDelete ? "Tap again to delete this chore" : "Delete chore")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.primary)
                        }
                        .buttonStyle(.plain).padding(.top, 2)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(editing ? "Edit chore" : "New chore")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing ? "Save" : "Add") { submit() }.fontWeight(.semibold).disabled(!canSave || saving)
                }
            }
            // New chore: land in the title field.
            .task { if !editing { try? await Task.sleep(for: .milliseconds(300)); titleFocused = true } }
        }
        .presentationDetents([.large])
    }

    private func labeled<V: View>(_ label: String, width: CGFloat? = nil, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 9) { SectionLabel(text: label); content() }
            .frame(maxWidth: width == nil ? .infinity : width, alignment: .leading)
    }

    private func personChip(_ id: String?, label: String) -> some View {
        let on = personId == id
        return Button { personId = id } label: {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? WF.ink : WF.ink2)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .wfChip(selected: on)
        }
        .buttonStyle(.plain)
    }

    /// The selected key, falling back to the household default.
    private var effectiveCurrencyKey: String? {
        currencyKey ?? currencies.first(where: { $0.isDefault })?.key
    }
    private var selectedCurrency: WaffledAPI.Currency? {
        currencies.first { $0.key == effectiveCurrencyKey }
    }
    /// The amount stepper's icon — the chosen currency's symbol, else the gold star.
    @ViewBuilder private var rewardSymbol: some View {
        if let c = selectedCurrency {
            Text(c.symbol).font(.system(size: 14))
        } else {
            Image(systemName: "star.fill").font(.system(size: 13)).foregroundStyle(WF.gold)
        }
    }

    private func submit() {
        var body: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "emoji": emoji.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(emoji.trimmingCharacters(in: .whitespaces)),
            "personId": personId.map(JSONValue.string) ?? .null,
            "rewardAmount": .int(stars),
            // One-off ("Just once") sends no rrule (null); recurring sends FREQ=…
            "rrule": buildRrule().map(JSONValue.string) ?? .null,
            "requiresApproval": .bool(requiresApproval),
            "requiresPhoto": .bool(requiresPhoto),
        ]
        // Pass the chosen currency when the household has more than one (else the
        // backend uses its default).
        if currencies.count > 1, let key = effectiveCurrencyKey {
            body["rewardCurrency"] = .string(key)
        }
        // The "On" day applies to a one-off (create sets the instance's day; edit moves
        // it). The server defaults it to household-local today if omitted and ignores it
        // for recurring chores.
        if freq == "once" {
            body["dueOn"] = .string(DateFmt.string(dueOn, "yyyy-MM-dd", .current))
        }
        Task {
            saving = true; saveError = nil
            let err = await onSave(editChoreId, body)
            saving = false
            if let err { saveError = err } else { dismiss() }
        }
    }

    /// nil = one-off ("Just once"); else the recurrence rule.
    private func buildRrule() -> String? {
        switch freq {
        case "once": return nil
        case "weekly":
            guard !days.isEmpty else { return nil }   // canSave already guards this
            let ordered = Self.days.map(\.code).filter { days.contains($0) }
            return "FREQ=WEEKLY;BYDAY=\(ordered.joined(separator: ","))"
        default: return "FREQ=DAILY"
        }
    }

    private static func parseRrule(_ rrule: String?) -> (freq: String, days: [String]) {
        // A blank/absent rrule is a one-off — NOT a daily chore. (Editing a one-off must
        // keep "once", or saving would silently convert it to a recurring daily chore.)
        guard let r = rrule, !r.trimmingCharacters(in: .whitespaces).isEmpty else { return ("once", []) }
        guard r.uppercased().contains("FREQ=WEEKLY") else { return ("daily", []) }
        guard let range = r.range(of: "BYDAY=", options: .caseInsensitive) else { return ("weekly", []) }
        let rest = r[range.upperBound...].prefix { $0.isLetter || $0 == "," }
        return ("weekly", rest.uppercased().split(separator: ",").map(String.init))
    }
}

private extension View {
    /// The shared WF card-field chrome (white, hairline border, rounded).
    func cardField() -> some View {
        frame(maxWidth: .infinity, alignment: .leading).wfField()
    }
}
