import Foundation

// Static, mock-faithful sample data for the Phase 0 scaffold. Mirrors the handoff
// iOS screens (the Hendricks family). Replaced by PowerSync-backed reads in Phase 1.

struct Member: Identifiable {
    let id = UUID()
    let name: String
    let color: FamilyColor
    let emoji: String
    let sub: String       // "Dad" / "★ 31"
    let stars: Int?
}

struct AgendaItem: Identifiable {
    let id = UUID()
    let time: String
    let title: String
    let owner: FamilyColor
}

enum Sample {
    static let members: [Member] = [
        Member(name: "Kevin",  color: .kevin,  emoji: "🐻", sub: "Dad",  stars: nil),
        Member(name: "Kelly",  color: .kelly,  emoji: "🦊", sub: "Mom",  stars: nil),
        Member(name: "Wally",  color: .wally,  emoji: "🐢", sub: "★ 31", stars: 31),
        Member(name: "Lottie", color: .lottie, emoji: "🦄", sub: "★ 24", stars: 24),
    ]

    static let todaysAgenda: [AgendaItem] = [
        AgendaItem(time: "8:30 AM", title: "Swim lessons",     owner: .wally),
        AgendaItem(time: "1:30 PM", title: "Psychiatrist appt", owner: .kevin),
        AgendaItem(time: "5:30 PM", title: "Tele-health call",  owner: .kelly),
    ]

    static let greetingDate = "Saturday, May 31"
}
