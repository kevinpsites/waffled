import SwiftUI

/// Calendar countdowns — "N days until X" from three sources (a flagged event, a
/// standalone item, or a member's next birthday), merged + sorted server-side by
/// `GET /api/countdowns`. A core Calendar feature (never gated). Surfaced as a Today
/// card, month-grid badges, and an "is countdown" toggle in the event editor. Only
/// standalone items are editable from here; events/birthdays are managed at their source.

// MARK: - Formatting

enum CountdownFormat {
    /// The Today-card wording (honors the household "sleeps" setting).
    static func label(_ daysLeft: Int, sleeps: Bool) -> String {
        if daysLeft <= 0 { return "Today!" }
        if daysLeft == 1 { return sleeps ? "1 sleep" : "Tomorrow" }
        return "\(daysLeft) \(sleeps ? "sleeps" : "days")"
    }
    /// The compact month-badge form ("Today!" / "5d"), which ignores the sleeps setting.
    static func short(_ daysLeft: Int) -> String { daysLeft <= 0 ? "Today!" : "\(daysLeft)d" }

    private static let parse: DateFormatter = {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
    private static let disp: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "MMM d"; return f
    }()
    /// "2026-08-03" → "Aug 3".
    static func dateLabel(_ ymd: String) -> String { parse.date(from: ymd).map { disp.string(from: $0) } ?? "" }
    static func ymd(_ date: Date) -> String { parse.string(from: date) }
    static func date(_ ymd: String) -> Date? { parse.date(from: ymd) }
}

// MARK: - Model

@MainActor
@Observable
final class CountdownsModel {
    typealias FetchCountdowns = () async throws -> (items: [WaffledAPI.Countdown], sleeps: Bool)
    typealias CreateCountdown = (_ title: String, _ date: String, _ emoji: String?) async throws -> Void
    typealias UpdateCountdown = (_ id: String, _ title: String, _ date: String, _ emoji: String?) async throws -> Void
    typealias DeleteCountdown = (_ id: String) async throws -> Void

    private(set) var items: [WaffledAPI.Countdown] = [] {
        didSet { byDate = Dictionary(grouping: items, by: \.date) }
    }
    /// Countdowns grouped by their `YYYY-MM-DD` date, for month-grid badges. Stored
    /// (rebuilt when `items` changes) so 42 month cells don't each regroup it per render.
    private(set) var byDate: [String: [WaffledAPI.Countdown]] = [:]
    private(set) var sleeps = false
    private(set) var loaded = false

    private let fetchCountdowns: FetchCountdowns
    private let createCountdown: CreateCountdown
    private let updateCountdown: UpdateCountdown
    private let deleteCountdown: DeleteCountdown
    private var deletingIDs: Set<String> = []

    init(
        fetchCountdowns: @escaping FetchCountdowns = {
            let response = try await WaffledAPI().countdowns()
            return (response.items, response.sleeps)
        },
        createCountdown: @escaping CreateCountdown = { title, date, emoji in
            _ = try await WaffledAPI().createCountdown(title: title, date: date, emoji: emoji)
        },
        updateCountdown: @escaping UpdateCountdown = { id, title, date, emoji in
            try await WaffledAPI().updateCountdown(id: id, title: title, date: date, emoji: emoji)
        },
        deleteCountdown: @escaping DeleteCountdown = { id in
            try await WaffledAPI().deleteCountdown(id: id)
        }
    ) {
        self.fetchCountdowns = fetchCountdowns
        self.createCountdown = createCountdown
        self.updateCountdown = updateCountdown
        self.deleteCountdown = deleteCountdown
    }

    func load() async {
        if let response = try? await fetchCountdowns() {
            items = response.items
            sleeps = response.sleeps
        }
        loaded = true
    }

    func add(title: String, date: String, emoji: String?) async throws {
        try await createCountdown(title, date, emoji)
        await load()
    }

    /// Only standalone items can be removed (events/birthdays are managed at their source).
    func remove(_ c: WaffledAPI.Countdown) async throws {
        guard c.isStandalone, deletingIDs.insert(c.id).inserted else { return }
        defer { deletingIDs.remove(c.id) }
        try await deleteCountdown(c.id)
        items.removeAll { $0.id == c.id }
    }

    /// Rename / move a standalone countdown (events/birthdays are edited at their source).
    func update(_ c: WaffledAPI.Countdown, title: String, date: String, emoji: String?) async throws {
        guard c.isStandalone else { return }
        try await updateCountdown(c.id, title, date, emoji)
        await load()
    }
}

// MARK: - Today card

/// The Today countdowns card, shared by iPhone (`kiosk == false`, `WaffledCard` chrome)
/// and the iPad family display (`kiosk == true`, `KioskCard` chrome + larger type, fewer
/// rows). Self-contained: it owns its `CountdownsModel` + the add/edit sheets, so both
/// screens get add / rename-move (tap a standalone row) / remove without re-wiring.
struct CountdownsCard: View {
    var kiosk = false
    @State private var model = CountdownsModel()
    @State private var adding = false
    @State private var editing: WaffledAPI.Countdown?
    @State private var errorMessage: String?
    private var cap: Int { kiosk ? 4 : 6 }

    var body: some View {
        Group {
            if kiosk { KioskCard { inner } } else { WaffledCard(padding: 15) { inner } }
        }
        .task { await model.load() }
        .sheet(isPresented: $adding) {
            AddCountdownSheet { title, date, emoji in
                try await model.add(title: title, date: date, emoji: emoji)
            }
        }
        .sheet(item: $editing) { c in
            EditCountdownSheet(countdown: c,
                onSave: { title, date, emoji in
                    try await model.update(c, title: title, date: date, emoji: emoji)
                },
                onRemove: { try await model.remove(c) })
        }
        .alert("Countdown unchanged", isPresented: errorPresented) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The countdown could not be changed.")
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } })
    }

    @ViewBuilder private var inner: some View {
        VStack(alignment: .leading, spacing: kiosk ? 12 : 10) {
            HStack(spacing: 8) {
                Text("Countdowns")
                    .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                    .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                Spacer(minLength: 6)
                Button { adding = true } label: {
                    HStack(spacing: kiosk ? 4 : 3) {
                        Image(systemName: "plus").font(.system(size: kiosk ? 12 : 10, weight: .bold))
                        Text("Add").font(.system(size: kiosk ? 14 : 12, weight: .semibold))
                    }.foregroundStyle(WF.ai)
                }.buttonStyle(.plain)
            }
            if model.items.isEmpty {
                Text(model.loaded ? "Nothing to count down to yet — add a trip; birthdays are automatic."
                                  : "Loading…")
                    .font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, kiosk ? 4 : 0)
            } else {
                ForEach(model.items.prefix(cap)) { row($0) }
                if model.items.count > cap {
                    Text("+\(model.items.count - cap) more").font(.system(size: kiosk ? 13 : 11, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
        }
    }

    private func row(_ c: WaffledAPI.Countdown) -> some View {
        let soon = c.daysLeft <= 7
        return HStack(spacing: kiosk ? 12 : 10) {
            if kiosk {
                Text(c.emoji ?? "📅").font(.system(size: 22))
            } else {
                Text(c.emoji ?? "📅").font(.system(size: 17))
                    .frame(width: 32, height: 32)
                    .background((c.color.flatMap { Color(hexString: $0) } ?? WF.panel).opacity(c.color == nil ? 1 : 0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(c.title).font(.system(size: kiosk ? 18 : 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Text(CountdownFormat.dateLabel(c.date)).font(.system(size: kiosk ? 13 : 11)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: kiosk ? 8 : 6)
            Text(CountdownFormat.label(c.daysLeft, sleeps: model.sleeps))
                .font(.system(size: kiosk ? 15 : 12.5, weight: .bold))
                .foregroundStyle(soon ? WF.primaryD : WF.ink2)
            if c.isStandalone {
                Button { remove(c) } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: kiosk ? 18 : 15)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            }
        }
        // Tap a standalone row to rename/move it; the × still removes. Events/birthdays
        // aren't editable here (managed at their source), so their rows don't tap.
        .contentShape(Rectangle())
        .onTapGesture { if c.isStandalone { editing = c } }
    }

    private func remove(_ countdown: WaffledAPI.Countdown) {
        Task {
            do {
                try await model.remove(countdown)
            } catch {
                errorMessage = "Couldn’t remove this countdown. Check your connection and try again."
            }
        }
    }
}

// MARK: - Add sheet

struct AddCountdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (_ title: String, _ date: String, _ emoji: String?) async throws -> Void

    @State private var title = ""
    @State private var date = Date()
    @State private var emoji = ""
    @State private var saving = false
    @State private var errorMessage: String?

    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    field("What are you counting down to?") {
                        TextField("e.g. Beach trip", text: $title).textInputAutocapitalization(.sentences)
                    }
                    HStack(spacing: 12) {
                        field("Emoji") { TextField("🏖️", text: $emoji).onChange(of: emoji) { _, v in emoji = String(v.prefix(2)) } }
                            .frame(width: 96)
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Date")
                            DatePicker("", selection: $date, in: Date()..., displayedComponents: .date)
                                .labelsHidden().datePickerStyle(.compact).tint(WF.primary)
                        }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Add countdown").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Adding…" : "Add") { save() }.fontWeight(.semibold).disabled(!canSave || saving)
                }
            }
        }
        .presentationDetents([.height(320), .medium])
        .alert("Countdown not added", isPresented: errorPresented) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The countdown could not be added.")
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } })
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: label)
            content()
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 15).padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading).wfField()
        }
    }

    private func save() {
        saving = true
        let t = title.trimmingCharacters(in: .whitespaces)
        let e = emoji.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await onAdd(t, CountdownFormat.ymd(date), e.isEmpty ? nil : e)
                dismiss()
            } catch {
                errorMessage = "Couldn’t add this countdown. Check your connection and try again."
                saving = false
            }
        }
    }
}

// MARK: - Edit sheet (standalone only)

/// Rename / move / remove a standalone countdown — the parity for the web calendar's
/// countdown editor. Seeded from the tapped countdown; Save calls `updateCountdown`,
/// Remove calls `deleteCountdown`.
struct EditCountdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let countdown: WaffledAPI.Countdown
    let onSave: (_ title: String, _ date: String, _ emoji: String?) async throws -> Void
    let onRemove: () async throws -> Void

    @State private var title: String
    @State private var date: Date
    @State private var emoji: String
    @State private var busy = false
    @State private var errorMessage: String?

    init(countdown: WaffledAPI.Countdown,
         onSave: @escaping (_ title: String, _ date: String, _ emoji: String?) async throws -> Void,
         onRemove: @escaping () async throws -> Void) {
        self.countdown = countdown
        self.onSave = onSave
        self.onRemove = onRemove
        _title = State(initialValue: countdown.title)
        _date = State(initialValue: CountdownFormat.date(countdown.date) ?? Date())
        _emoji = State(initialValue: countdown.emoji ?? "")
    }

    private var canSave: Bool { !title.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    field("What are you counting down to?") {
                        TextField("e.g. Beach trip", text: $title).textInputAutocapitalization(.sentences)
                    }
                    HStack(spacing: 12) {
                        field("Emoji") { TextField("🏖️", text: $emoji).onChange(of: emoji) { _, v in emoji = String(v.prefix(2)) } }
                            .frame(width: 96)
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Date")
                            DatePicker("", selection: $date, displayedComponents: .date)
                                .labelsHidden().datePickerStyle(.compact).tint(WF.primary)
                        }
                    }
                    Button(role: .destructive) {
                        remove()
                    } label: {
                        HStack { Image(systemName: "trash"); Text("Remove countdown") }
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .disabled(busy)
                    .padding(.top, 4)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Edit countdown").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") { save() }.fontWeight(.semibold).disabled(!canSave || busy)
                }
            }
        }
        .presentationDetents([.height(360), .medium])
        .alert("Countdown unchanged", isPresented: errorPresented) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The countdown could not be changed.")
        }
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } })
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: label)
            content()
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 15).padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading).wfField()
        }
    }

    private func save() {
        busy = true
        let t = title.trimmingCharacters(in: .whitespaces)
        let e = emoji.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await onSave(t, CountdownFormat.ymd(date), e.isEmpty ? nil : e)
                dismiss()
            } catch {
                errorMessage = "Couldn’t save this countdown. Check your connection and try again."
                busy = false
            }
        }
    }

    private func remove() {
        busy = true
        Task {
            do {
                try await onRemove()
                dismiss()
            } catch {
                errorMessage = "Couldn’t remove this countdown. Check your connection and try again."
                busy = false
            }
        }
    }
}
