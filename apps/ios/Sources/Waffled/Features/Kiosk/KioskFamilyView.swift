import SwiftUI

/// The iPad Family page — a per-person overview grid (each member's day + chores at a
/// glance), tapping into the full person spotlight (`PersonView`). Replaces the
/// iPhone hub's launcher tiles, which on iPad are redundant with the nav rail.
/// See `apps/ios/IPAD_ROADMAP.md`.
struct KioskFamilyView: View {
    @Environment(SyncManager.self) private var sync
    @Binding var path: [HubRoute]
    @State private var model = KioskFamilyModel()

    private let cols = [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 16, alignment: .top)]
    /// Verification one-shot (WAFFLED_OPEN_PERSON).
    private static var didOpenPerson = false

    private struct LoadKey: Hashable {
        let choresEnabled: Bool
        let choresRevision: Int
        let rewardsRevision: Int
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                KioskPageHeader("Family", "Tap a person to see just their day, chores & goals.")
                if case .loading = model.state {
                    WaffledLoading(top: 12)
                        .frame(maxWidth: .infinity)
                } else {
                    RestStateNotice(state: model.state, retry: { Task { await loadRestData() } })
                }
                // Members and today's schedule come from PowerSync, so keep those
                // useful cards visible while the REST-only chore/star details load.
                LazyVGrid(columns: cols, alignment: .leading, spacing: 16) {
                    ForEach(sync.members) { m in personCard(m) }
                }
            }
            .padding(24)
        }
        .background(WF.canvas)
        .toolbar(.hidden, for: .navigationBar)   // draws its own "Family" header
        .task(id: loadKey) {
            await loadRestData()
            if DemoHooks.openPerson, !Self.didOpenPerson, let first = sync.members.first {
                Self.didOpenPerson = true; path.append(.person(first.id))
            }
        }
        .refreshable { await loadRestData() }
    }

    private var loadKey: LoadKey {
        .init(
            choresEnabled: sync.module(.chores),
            choresRevision: sync.choresRev,
            rewardsRevision: sync.rewardsRev
        )
    }

    private func loadRestData() async {
        await sync.loadIdentity()
        guard !Task.isCancelled else { return }
        await model.load(choresEnabled: sync.module(.chores))
    }

    // MARK: a person card

    private func personCard(_ m: SyncedMember) -> some View {
        let pc = model.chores.first { $0.id == m.id }
        let balance = model.stars.first { $0.name == m.name }?.stars
        let events = todayEvents(for: m)
        let tint = Color(hexString: m.colorHex) ?? WF.ink3
        return Button { path.append(.person(m.id)) } label: {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name).font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                        Text(m.memberType?.capitalized ?? "")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    Spacer(minLength: 6)
                    if let balance { Text("★ \(balance)").font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.gold) }
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                }

                if sync.module(.chores), let pc, pc.total > 0 {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("CHORES").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                            Spacer()
                            Text("\(pc.done) of \(pc.total)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                        ProgressBar(value: Double(pc.done) / Double(pc.total), tint: tint, track: tint.opacity(0.18))
                    }
                }

                VStack(alignment: .leading, spacing: 7) {
                    Text("TODAY").font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                    if events.isEmpty {
                        Text("Nothing scheduled").font(.system(size: 13)).foregroundStyle(WF.ink3)
                    } else {
                        ForEach(events.prefix(3)) { ev in
                            HStack(spacing: 8) {
                                RoundedRectangle(cornerRadius: 99).fill(sync.eventPalette.color(for: ev, fallback: tint)).frame(width: 3, height: 16)
                                Text(ev.allDay ? "All day" : (ev.startsAt.map { EventTime.timeLabel($0, sync.householdTz) } ?? ""))
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                                    .frame(width: 62, alignment: .leading)
                                RhythmEventMark(event: ev, size: 11)
                                Text(ev.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                        }
                        if events.count > 3 {
                            Text("+\(events.count - 3) more").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField()
        }
        .buttonStyle(.plain)
    }

    private func todayEvents(for m: SyncedMember) -> [SyncedEvent] {
        let mine = sync.events.filter { $0.personId == m.id || $0.participantIds.contains(m.id) }
        return Agenda.forDay(mine, day: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }
}
