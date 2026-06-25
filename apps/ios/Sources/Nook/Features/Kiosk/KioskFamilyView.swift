import SwiftUI

/// The iPad Family page — a per-person overview grid (each member's day + chores at a
/// glance), tapping into the full person spotlight (`PersonView`). Replaces the
/// iPhone hub's launcher tiles, which on iPad are redundant with the nav rail.
/// See `apps/ios/IPAD_ROADMAP.md`.
struct KioskFamilyView: View {
    @Environment(SyncManager.self) private var sync
    @Binding var path: [HubRoute]
    @State private var chores: [NookAPI.PersonChoresDTO] = []
    @State private var stars: [NookAPI.FamilyStarsDTO] = []

    private let cols = [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 16, alignment: .top)]
    /// Verification one-shot (NOOK_OPEN_PERSON).
    private static var didOpenPerson = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                KioskPageHeader("Family", "Tap a person to see just their day, chores & goals.")
                LazyVGrid(columns: cols, alignment: .leading, spacing: 16) {
                    ForEach(sync.members) { m in personCard(m) }
                }
            }
            .padding(24)
        }
        .background(NK.canvas)
        .toolbar(.hidden, for: .navigationBar)   // draws its own "Family" header
        .task {
            await sync.loadIdentity(); await load()
            if DemoHooks.openPerson, !Self.didOpenPerson, let first = sync.members.first {
                Self.didOpenPerson = true; path.append(.person(first.id))
            }
        }
        .refreshable { await load() }
        .onChange(of: sync.choresRev) { _, _ in Task { await load() } }
    }

    private func load() async {
        async let c = (try? await NookAPI().choresToday()) ?? []
        async let s = (try? await NookAPI().familyStars()) ?? []
        chores = await c
        stars = await s
    }

    // MARK: a person card

    private func personCard(_ m: SyncedMember) -> some View {
        let pc = chores.first { $0.id == m.id }
        let balance = stars.first { $0.name == m.name }?.stars
        let events = todayEvents(for: m)
        let tint = Color(hexString: m.colorHex) ?? NK.ink3
        return Button { path.append(.person(m.id)) } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name).font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                        Text(m.memberType?.capitalized ?? "")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                    Spacer(minLength: 6)
                    if let balance { Text("★ \(balance)").font(.system(size: 15, weight: .heavy)).foregroundStyle(NK.gold) }
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
                }

                if let pc, pc.total > 0 {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("CHORES").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                            Spacer()
                            Text("\(pc.done) of \(pc.total)").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
                        }
                        ProgressBar(value: Double(pc.done) / Double(pc.total), tint: tint, track: tint.opacity(0.18))
                    }
                }

                VStack(alignment: .leading, spacing: 7) {
                    Text("TODAY").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                    if events.isEmpty {
                        Text("Nothing scheduled").font(.system(size: 13)).foregroundStyle(NK.ink3)
                    } else {
                        ForEach(events.prefix(3)) { ev in
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 99).fill(Color(hexString: ev.colorHex) ?? tint).frame(width: 3, height: 16)
                                Text(ev.allDay ? "All day" : (ev.startsAt.map { EventTime.timeLabel($0, sync.householdTz) } ?? ""))
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                                    .frame(width: 62, alignment: .leading)
                                Text(ev.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                        if events.count > 3 {
                            Text("+\(events.count - 3) more").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .nkField()
        }
        .buttonStyle(.plain)
    }

    private func todayEvents(for m: SyncedMember) -> [SyncedEvent] {
        let mine = sync.events.filter { $0.personId == m.id || $0.participantIds.contains(m.id) }
        return Agenda.forDay(mine, day: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }
}
