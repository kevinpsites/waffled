import SwiftUI

/// Family Night — a weekly family gathering with a customizable agenda of "parts"
/// (Activity / Treat / Check-in …) that auto-rotate among members. A core-shaped
/// optional module (server key `familyNight`): a Today card whose per-part person
/// pickers override this week's rotation, plus an admin editor (day/time/agenda +
/// an optional weekly calendar event). Entirely REST — mirrors the web
/// `FamilyNightCard` / `FamilyNightSettings`.

// MARK: - Formatting

enum FamilyNightFormat {
    private static let parse: DateFormatter = {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
    private static let disp: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "EEE, MMM d"; return f
    }()
    /// "2026-06-08" → "Mon, Jun 8".
    static func dateLabel(_ ymd: String) -> String { parse.date(from: ymd).map { disp.string(from: $0) } ?? ymd }

    static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static func weekday(_ dow: Int) -> String { weekdays[((dow % 7) + 7) % 7] }

    /// "19:00" → a nicely-formatted local time like "7:00 PM".
    static func timeLabel(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return hhmm }
        var c = DateComponents(); c.hour = h; c.minute = m
        guard let d = Cal.gregorian(TimeZone.current).date(from: c) else { return hhmm }
        return DateFmt.string(d, "h:mm a", TimeZone.current)
    }
}

// MARK: - Model

@MainActor
@Observable
final class FamilyNightModel {
    private(set) var view: WaffledAPI.FamilyNightView?
    private(set) var loaded = false
    private let api = WaffledAPI()

    func load() async {
        view = try? await api.familyNight()
        loaded = true
    }

    /// Assign (or clear, `personId == nil`) a single agenda part for the upcoming
    /// gathering — a per-week override of the rotation. Reloads to reflect the write.
    func assign(partId: String, personId: String?) async {
        guard let date = view?.next.date else { return }
        _ = try? await api.saveFamilyNightOccurrence(date: date, assignments: [(partId, personId)])
        await load()
    }
}

// MARK: - Today card

/// The Today Family Night card, shared by iPhone (`kiosk == false`, `WaffledCard`) and the
/// iPad family display (`kiosk == true`, `KioskCard` + larger type). Both show the gathering's
/// date, its optional theme, and a per-part person picker that overrides this week's rotation.
struct FamilyNightCard: View {
    var kiosk = false
    @State private var model = FamilyNightModel()

    var body: some View {
        Group {
            if kiosk { KioskCard { inner } } else { WaffledCard(padding: 15) { inner } }
        }
        .task { await model.load() }
    }

    @ViewBuilder private var inner: some View {
        VStack(alignment: .leading, spacing: kiosk ? 12 : 10) {
            HStack(spacing: 8) {
                Text("🏡 Family Night")
                    .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                    .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                Spacer(minLength: 6)
                if let d = model.view?.next.date {
                    Text(FamilyNightFormat.dateLabel(d))
                        .font(.system(size: kiosk ? 14 : 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
            if let v = model.view {
                if let theme = v.next.theme, !theme.isEmpty {
                    Text(theme).font(.system(size: kiosk ? 15 : 13, weight: .semibold)).foregroundStyle(WF.ink)
                }
                if v.members.isEmpty {
                    Text("Add family members to start rotating the agenda.")
                        .font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, kiosk ? 4 : 0)
                } else {
                    ForEach(v.next.assignments) { partRow($0, members: v.members) }
                }
            } else {
                Text(model.loaded ? "Couldn’t load Family Night." : "Loading…")
                    .font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func partRow(_ a: WaffledAPI.FamilyNightAssignment, members: [WaffledAPI.FamilyNightMember]) -> some View {
        HStack(spacing: kiosk ? 12 : 10) {
            if kiosk {
                Text(a.emoji).font(.system(size: 22))
            } else {
                Text(a.emoji).font(.system(size: 17))
                    .frame(width: 32, height: 32)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            Text(a.label).font(.system(size: kiosk ? 18 : 14, weight: .semibold)).foregroundStyle(WF.ink)
            Spacer(minLength: kiosk ? 8 : 6)
            personPicker(a, members: members)
        }
    }

    /// A menu that assigns any member (or clears) to this part. The label shows the
    /// current pick — dimmed when it's only the rotation's suggestion, solid once set.
    private func personPicker(_ a: WaffledAPI.FamilyNightAssignment, members: [WaffledAPI.FamilyNightMember]) -> some View {
        Menu {
            ForEach(members) { m in
                Button {
                    Task { await model.assign(partId: a.partId, personId: m.id) }
                } label: {
                    if m.id == a.personId { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                }
            }
            if a.personId != nil {
                Divider()
                Button(role: .destructive) {
                    Task { await model.assign(partId: a.partId, personId: nil) }
                } label: { Label("Clear", systemImage: "xmark") }
            }
        } label: {
            if let name = a.personName {
                HStack(spacing: 6) {
                    if let m = members.first(where: { $0.id == a.personId }) {
                        Avatar(colorHex: m.color, emoji: m.emoji ?? "🙂", size: kiosk ? 26 : 22)
                    }
                    Text(name).font(.system(size: kiosk ? 15 : 13, weight: .semibold))
                        .foregroundStyle(a.suggested ? WF.ink3 : WF.ink)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                }
            } else {
                HStack(spacing: 4) {
                    Text("Pick").font(.system(size: kiosk ? 15 : 13, weight: .semibold))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(WF.ai)
            }
        }
    }
}
