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
    private(set) var items: [WaffledAPI.Countdown] = []
    private(set) var sleeps = false
    private(set) var loaded = false
    private let api = WaffledAPI()

    func load() async {
        if let r = try? await api.countdowns() { items = r.items; sleeps = r.sleeps }
        loaded = true
    }
    func add(title: String, date: String, emoji: String?) async {
        _ = try? await api.createCountdown(title: title, date: date, emoji: emoji)
        await load()
    }
    /// Only standalone items can be removed (events/birthdays are managed at their source).
    func remove(_ c: WaffledAPI.Countdown) async {
        guard c.isStandalone else { return }
        items.removeAll { $0.id == c.id }
        try? await api.deleteCountdown(id: c.id)
    }
    /// Countdowns grouped by their `YYYY-MM-DD` date, for month-grid badges.
    var byDate: [String: [WaffledAPI.Countdown]] { Dictionary(grouping: items, by: \.date) }
}

// MARK: - Today card

struct CountdownsCard: View {
    @State private var model = CountdownsModel()
    @State private var adding = false
    private let cap = 6

    var body: some View {
        WaffledCard(padding: 15) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Countdowns").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                    Spacer()
                    Button { adding = true } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "plus").font(.system(size: 10, weight: .bold))
                            Text("Add").font(.system(size: 12, weight: .semibold))
                        }.foregroundStyle(WF.ai)
                    }.buttonStyle(.plain)
                }
                if model.items.isEmpty {
                    Text(model.loaded ? "Nothing to count down to yet — add a trip; birthdays are automatic."
                                      : "Loading…")
                        .font(.system(size: 13)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(model.items.prefix(cap)) { row($0) }
                    if model.items.count > cap {
                        Text("+\(model.items.count - cap) more").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
        }
        .task { await model.load() }
        .sheet(isPresented: $adding) {
            AddCountdownSheet { title, date, emoji in await model.add(title: title, date: date, emoji: emoji) }
        }
    }

    private func row(_ c: WaffledAPI.Countdown) -> some View {
        let soon = c.daysLeft <= 7
        return HStack(spacing: 10) {
            Text(c.emoji ?? "📅").font(.system(size: 17))
                .frame(width: 32, height: 32)
                .background((c.color.flatMap { Color(hexString: $0) } ?? WF.panel).opacity(c.color == nil ? 1 : 0.16))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(c.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Text(CountdownFormat.dateLabel(c.date)).font(.system(size: 11)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 6)
            Text(CountdownFormat.label(c.daysLeft, sleeps: model.sleeps))
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(soon ? WF.primaryD : WF.ink2)
            if c.isStandalone {
                Button { Task { await model.remove(c) } } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Add sheet

struct AddCountdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (_ title: String, _ date: String, _ emoji: String?) async -> Void

    @State private var title = ""
    @State private var date = Date()
    @State private var emoji = ""
    @State private var saving = false

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
        Task { await onAdd(t, CountdownFormat.ymd(date), e.isEmpty ? nil : e); dismiss() }
    }
}
